import { hostLog } from "./vscodeApi";

/**
 * Problems that would otherwise fail silently in the webview (e.g. a CSP
 * violation blocking fonts or WASM decoders only degrades rendering). They are
 * forwarded to the "PDF Tools" output channel and kept for the tests.
 */
const problems: string[] = [];

export function collectedProblems(): readonly string[] {
  return problems;
}

function report(message: string): void {
  problems.push(message);
  hostLog("error", message);
}

export function watchForProblems(): void {
  document.addEventListener("securitypolicyviolation", (event) => {
    report(`CSP violation: ${event.violatedDirective} blocked ${event.blockedURI || "inline content"}`);
  });
  window.addEventListener("error", (event) => {
    report(`Uncaught error: ${event.message}`);
  });
  window.addEventListener("unhandledrejection", (event) => {
    const reason: unknown = event.reason;
    report(`Unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}`);
  });
}
