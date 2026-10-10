import type { WebviewToHost } from "../src/shared/protocol";

interface VsCodeApi {
  postMessage(message: WebviewToHost): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

/** The webview's channel to the extension host (acquirable only once). */
export const host: VsCodeApi = acquireVsCodeApi();

/** Forwards a message to the "PDF Tools" output channel. */
export function hostLog(level: "info" | "warn" | "error", message: string): void {
  host.postMessage({ type: "log", level, message });
}
