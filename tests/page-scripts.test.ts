import { describe, expect, test } from "bun:test";
import {
  buildChromeEvaluateExpression,
  buildExecuteJobScript,
  buildJobCleanupScript,
  buildJobPollScript,
  buildReadPageScript,
  parseReadPageOptions,
} from "../src/lib/page-scripts";

function run(script: string, globals: Record<string, unknown>): unknown {
  const names = Object.keys(globals);
  const values = names.map((name) => globals[name]);
  // eslint-disable-next-line no-new-func
  const fn = new Function(...names, `return ${script}`);
  return fn(...values);
}

function fakeDocument(overrides: Record<string, unknown> = {}) {
  return {
    title: "Example page",
    querySelector: () => null,
    body: { innerText: "", textContent: "" },
    ...overrides,
  };
}

describe("parseReadPageOptions", () => {
  test("defaults to text mode and clamps max chars", () => {
    expect(parseReadPageOptions({})).toEqual({ mode: "text", selector: "", maxChars: 12_000 });
    expect(parseReadPageOptions({ mode: "links", max_chars: 99_999 }).maxChars).toBe(50_000);
    expect(parseReadPageOptions({ max_chars: 10 }).maxChars).toBe(500);
    expect(parseReadPageOptions({ mode: "unsupported" }).mode).toBe("text");
  });
});

describe("buildReadPageScript", () => {
  test("returns cleaned text with metadata", () => {
    const document = fakeDocument({
      body: { innerText: "  Hello\n\n\n\nWorld  ", textContent: "unused" },
    });

    const parsed = JSON.parse(
      String(
        run(buildReadPageScript({ mode: "text" }), {
          document,
          location: { href: "https://example.com/x" },
          window: { getSelection: () => null },
        }),
      ),
    );

    expect(parsed).toMatchObject({
      ok: true,
      url: "https://example.com/x",
      title: "Example page",
      mode: "text",
      truncated: false,
    });
    expect(parsed.content).toBe("Hello\n\nWorld");
  });

  test("lists unique links and skips javascript: hrefs", () => {
    const anchors = [
      { href: "https://a.example/", innerText: "A" },
      { href: "javascript:void(0)", innerText: "bad" },
      { href: "https://a.example/", innerText: "duplicate" },
      { href: "https://b.example/", innerText: "" },
    ];
    const document = fakeDocument({
      body: { innerText: "", textContent: "", querySelectorAll: () => anchors },
    });

    const parsed = JSON.parse(
      String(
        run(buildReadPageScript({ mode: "links" }), {
          document,
          location: { href: "https://example.com" },
          window: { getSelection: () => null },
        }),
      ),
    );

    expect(parsed.count).toBe(2);
    expect(parsed.content).toContain("https://a.example/");
    expect(parsed.content).toContain("(no text) — https://b.example/");
    expect(parsed.content).not.toContain("javascript:");
  });

  test("reports missing selectors", () => {
    const document = fakeDocument();
    const parsed = JSON.parse(
      String(
        run(buildReadPageScript({ mode: "text", selector: "#missing" }), {
          document,
          location: { href: "https://example.com" },
          window: { getSelection: () => null },
        }),
      ),
    );

    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("#missing");
  });

  test("truncates long content and reports the original size", () => {
    const document = fakeDocument({
      body: { innerText: "x".repeat(1200), textContent: "" },
    });
    const parsed = JSON.parse(
      String(
        run(buildReadPageScript({ mode: "text", max_chars: 500 }), {
          document,
          location: { href: "https://example.com" },
          window: { getSelection: () => null },
        }),
      ),
    );

    expect(parsed.truncated).toBe(true);
    expect(parsed.totalChars).toBe(1200);
    expect(parsed.content).toHaveLength(500);
  });
});

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function runJob(code: string, globals: Record<string, unknown> = {}) {
  const key = "job_test";
  const window = {};
  run(buildExecuteJobScript(code, key), { window, document: fakeDocument(), ...globals });
  await flush();
  const jobs = (window as { __brogentJobs?: Record<string, unknown> }).__brogentJobs;
  return { key, window, job: jobs?.[key] as Record<string, unknown> | undefined };
}

describe("execute_javascript job scripts", () => {
  test("captures synchronous results", async () => {
    const { job } = await runJob("return 1 + 1;");
    expect(job).toEqual({ status: "done", ok: true, result: 2 });
  });

  test("awaits promises", async () => {
    const { job } = await runJob('return await Promise.resolve("hi");');
    expect(job).toMatchObject({ ok: true, result: "hi" });
  });

  test("captures thrown errors", async () => {
    const { job } = await runJob('throw new Error("boom");');
    expect(job?.ok).toBe(false);
    expect(String(job?.error)).toContain("boom");
  });

  test("serializes cycles and DOM-ish objects", async () => {
    const { job } = await runJob("const a = { x: 1 }; a.self = a; return a;");
    expect(job?.result).toEqual({ x: 1, self: "[Circular]" });
  });

  test("refuses oversized results instead of returning broken JSON", async () => {
    const { job } = await runJob('return "x".repeat(50000);');
    expect(job?.ok).toBe(false);
    expect(String(job?.error)).toMatch(/too large/i);
  });

  test("polling returns the result once and then forgets it", async () => {
    const { key, window, job } = await runJob("return [1, 2, 3];");
    expect(job).toMatchObject({ ok: true, result: [1, 2, 3] });

    const polled = JSON.parse(String(run(buildJobPollScript(key), { window })));
    expect(polled).toMatchObject({ status: "done", ok: true, result: [1, 2, 3] });

    expect(String(run(buildJobPollScript(key), { window }))).toBe("");
  });

  test("cleanup removes a pending job", async () => {
    const key = "job_pending";
    const window = {};
    const jobs: Record<string, unknown> = {};
    (window as { __brogentJobs?: Record<string, unknown> }).__brogentJobs = jobs;
    jobs[key] = { status: "running" };

    run(buildJobCleanupScript(key), { window });

    expect(String(run(buildJobPollScript(key), { window }))).toBe("");
  });
});

async function runExpression(code: string, globals: Record<string, unknown> = {}): Promise<unknown> {
  const expression = buildChromeEvaluateExpression(code);
  const names = Object.keys(globals);
  const values = names.map((name) => globals[name]);
  const fn = new Function(...names, `return ${expression}`);
  return fn(...values);
}

describe("buildChromeEvaluateExpression", () => {
  test("returns a JSON success payload", async () => {
    const raw = await runExpression("return { answer: 42, list: [1, 2] };");
    expect(JSON.parse(String(raw))).toEqual({ ok: true, result: { answer: 42, list: [1, 2] } });
  });

  test("awaits promises", async () => {
    const raw = await runExpression('return await Promise.resolve("hi");');
    expect(JSON.parse(String(raw))).toEqual({ ok: true, result: "hi" });
  });

  test("reports thrown errors", async () => {
    const parsed = JSON.parse(String(await runExpression('throw new Error("boom");')));
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("boom");
  });

  test("serializes cycles", async () => {
    const raw = await runExpression("const a = { x: 1 }; a.self = a; return a;");
    expect(JSON.parse(String(raw))).toEqual({ ok: true, result: { x: 1, self: "[Circular]" } });
  });
});
