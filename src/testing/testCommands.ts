import * as vscode from "vscode";
import { openPageLink } from "../commands";
import type { PdfEditorProvider } from "../editor/pdfEditorProvider";
import type { ViewerRequest } from "../shared/protocol";

let nextPassword: string | undefined;

/** The password queued by `pdfTools.test.setNextPassword`, consumed once. */
export function takeTestPassword(): string | undefined {
  const password = nextPassword;
  nextPassword = undefined;
  return password;
}

/**
 * Commands that let the integration tests drive the webview, which they cannot
 * reach directly. Registered only when the extension runs in test mode
 * (`ExtensionMode.Test`); never contributed in package.json.
 */
export function registerTestCommands(provider: PdfEditorProvider): vscode.Disposable {
  const findPanel = (uri: string, index: number) => {
    const document = [...provider.documents].find((candidate) => candidate.uri.toString() === uri);
    const panel = document && [...document.panels][index];
    if (!panel) {
      throw new Error(`No PDF Tools editor #${index} for ${uri}`);
    }
    return panel;
  };

  return vscode.Disposable.from(
    vscode.commands.registerCommand("pdfTools.test.setNextPassword", (password: string) => {
      nextPassword = password;
    }),
    vscode.commands.registerCommand("pdfTools.test.getState", () =>
      [...provider.documents].map((document) => ({
        uri: document.uri.toString(),
        panels: [...document.panels].map((panel) => ({
          ...panel.state,
          loaded: panel.isLoaded,
          active: panel === provider.activePanel,
        })),
      })),
    ),
    vscode.commands.registerCommand(
      "pdfTools.test.setFieldValues",
      (uri: string, values: Record<string, string | boolean>, panelIndex = 0) =>
        findPanel(uri, panelIndex).requestTest((requestId) => ({ type: "test.setFieldValues", requestId, values })),
    ),
    vscode.commands.registerCommand("pdfTools.test.getFieldValues", (uri: string, panelIndex = 0) =>
      findPanel(uri, panelIndex).requestTest((requestId) => ({ type: "test.getFieldValues", requestId })),
    ),
    vscode.commands.registerCommand("pdfTools.test.getProblems", (uri: string, panelIndex = 0) =>
      findPanel(uri, panelIndex).requestTest((requestId) => ({ type: "test.getProblems", requestId })),
    ),
    vscode.commands.registerCommand("pdfTools.test.getViewState", (uri: string, panelIndex = 0) =>
      findPanel(uri, panelIndex).requestTest((requestId) => ({ type: "test.getViewState", requestId })),
    ),
    vscode.commands.registerCommand(
      "pdfTools.test.find",
      (uri: string, query: string, options?: { caseSensitive?: boolean; entireWord?: boolean; matchDiacritics?: boolean }) =>
        findPanel(uri, 0).requestTest((requestId) => ({ type: "test.find", requestId, query, options }), 30_000),
    ),
    vscode.commands.registerCommand("pdfTools.test.goToPage", (uri: string, page: string) =>
      findPanel(uri, 0).post({ type: "goToPage", page }),
    ),
    // The view remembered for a file (saved by the webview a moment after each change).
    vscode.commands.registerCommand("pdfTools.test.getRememberedView", (uri: string) => provider.viewStates.get(vscode.Uri.parse(uri))),
    vscode.commands.registerCommand("pdfTools.test.getStatus", (uri: string, panelIndex = 0) => findPanel(uri, panelIndex).status),
    vscode.commands.registerCommand("pdfTools.test.request", (uri: string, request: ViewerRequest) =>
      findPanel(uri, 0).request(request),
    ),
    // What the URI handler receives when a "Copy Link to This Page" link is opened.
    vscode.commands.registerCommand("pdfTools.test.openLink", (link: string) => openPageLink(provider, vscode.Uri.parse(link))),
  );
}
