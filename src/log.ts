import * as vscode from "vscode";

let channel: vscode.LogOutputChannel | undefined;

/** The "PDF Tools" output channel, created on first use. */
export function log(): vscode.LogOutputChannel {
  channel ??= vscode.window.createOutputChannel("PDF Tools", { log: true });
  return channel;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
