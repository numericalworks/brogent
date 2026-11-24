/**
 * Cross-browser platform shim.
 *
 * Firefox exposes the promise-based `browser` namespace (MV2). Chrome exposes
 * `chrome` (and, from Chrome 148, a standardized `browser` namespace as well).
 * We detect the browser from the manifest version, not from the namespace,
 * because newer Chrome also provides `browser`.
 */

export interface ChromeInjectionResult {
  result?: unknown;
  error?: string;
}

export interface ChromeApi {
  scripting?: {
    executeScript: (injection: {
      target: { tabId: number };
      func: (...args: any[]) => unknown;
      args?: unknown[];
      world?: "ISOLATED" | "MAIN";
    }) => Promise<ChromeInjectionResult[]>;
  };
  userScripts?: {
    execute: (injection: {
      target: { tabId: number };
      js: Array<{ code: string }>;
      world?: "USER_SCRIPT" | "MAIN";
      injectImmediately?: boolean;
    }) => Promise<ChromeInjectionResult[]>;
  };
  sidePanel?: {
    setPanelBehavior: (options: { openPanelOnActionClick: boolean }) => Promise<void>;
  };
}

const scope = globalThis as {
  browser?: typeof browser;
  chrome?: ChromeApi;
};

export const chromeApi: ChromeApi | undefined = scope.chrome;
export const ext = (scope.browser ?? (scope.chrome as unknown)) as typeof browser;
export const isChrome = ext.runtime.getManifest().manifest_version === 3;
