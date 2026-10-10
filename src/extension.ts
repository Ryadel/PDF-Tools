import * as vscode from "vscode";
import { registerCommands } from "./commands";
import { PdfEditorProvider } from "./editor/pdfEditorProvider";
import { deleteOldTempCopies } from "./print/printService";
import { PdfStatusBar } from "./statusBar";
import { registerTestCommands } from "./testing/testCommands";

export function activate(context: vscode.ExtensionContext): void {
  const { provider, disposable } = PdfEditorProvider.register(context);
  const statusBar = new PdfStatusBar();

  context.subscriptions.push(
    provider,
    disposable,
    statusBar,
    registerCommands(context, provider),
    provider.onDidChangeActivePanel((panel) => statusBar.update(panel)),
    provider.onDidChangePanelStatus((panel) => {
      if (panel === provider.activePanel) {
        statusBar.update(panel);
      }
    }),
  );

  if (context.extensionMode === vscode.ExtensionMode.Test) {
    context.subscriptions.push(registerTestCommands(provider));
  }

  void deleteOldTempCopies();
}

export function deactivate(): void {}
