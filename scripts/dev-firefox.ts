/**
 * Launches web-ext with a TMPDIR that Firefox can actually read.
 *
 * When Firefox is installed as a snap, it runs in a private /tmp. web-ext
 * creates its temporary profile under the system temp dir (os.tmpdir()) and
 * writes `devtools.debugger.remote-enabled` into it, then starts Firefox with
 * `-profile <dir> -start-debugger-server <port>`. The snap cannot see that
 * profile, so the debugger server never starts and web-ext fails with
 * `ECONNREFUSED 127.0.0.1:<port>`.
 *
 * Pointing TMPDIR at a directory under the project (which lives under $HOME,
 * so the snap's `home` interface grants access) makes the profile visible and
 * lets web-ext connect. Harmless for non-snap Firefox too.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const tmpDir = join(root, "webext-tmp");
mkdirSync(tmpDir, { recursive: true });

const proc = Bun.spawn(["bunx", "--bun", "web-ext", "run", "--source-dir", "dist"], {
  cwd: root,
  env: { ...process.env, TMPDIR: tmpDir },
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});

process.exit(await proc.exited);
