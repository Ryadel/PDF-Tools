import * as vscode from "vscode";
import { LIVE_SETTINGS } from "../settings";
import type { HostCommand } from "../shared/protocol";
import { EditorPanel, type EditorPanelHost } from "./editorPanel";
import { PdfDocument } from "./pdfDocument";
import { ViewStateStore } from "./viewStateStore";

/**
 * Editable custom editor for PDF files. One {@link PdfDocument} per file, one
 * {@link EditorPanel} per open editor (a file can be open in several groups).
 */
export class PdfEditorProvider implements vscode.CustomEditorProvider<PdfDocument>, EditorPanelHost {
  static readonly viewType = "pdfTools.editor";

  static register(context: vscode.ExtensionContext): { provider: PdfEditorProvider; disposable: vscode.Disposable } {
    const provider = new PdfEditorProvider(
      context.extensionUri,
      context.extensionMode === vscode.ExtensionMode.Test,
      new ViewStateStore(context.globalState),
    );
    const disposable = vscode.window.registerCustomEditorProvider(PdfEditorProvider.viewType, provider, {
      // The form state lives in the webview until it is saved, so the webview
      // must survive being hidden (e.g. switching tabs).
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: true,
    });
    return { provider, disposable };
  }

  readonly #onDidChangeCustomDocument = new vscode.EventEmitter<vscode.CustomDocumentContentChangeEvent<PdfDocument>>();
  readonly onDidChangeCustomDocument = this.#onDidChangeCustomDocument.event;
  readonly #onDidChangeActivePanel = new vscode.EventEmitter<EditorPanel | undefined>();
  /** The focused PDF editor changed (or none is focused any more). */
  readonly onDidChangeActivePanel = this.#onDidChangeActivePanel.event;
  readonly #onDidChangePanelStatus = new vscode.EventEmitter<EditorPanel>();
  readonly onDidChangePanelStatus = this.#onDidChangePanelStatus.event;

  readonly #documents = new Set<PdfDocument>();
  /** Pages to open documents at, by URI (links from "Copy Link to This Page"). */
  readonly #pendingPages = new Map<string, number>();
  readonly #settingsListener: vscode.Disposable;
  #activePanel: EditorPanel | undefined;
  #runHostCommand: (command: HostCommand, panel: EditorPanel) => void = () => undefined;

  private constructor(
    readonly extensionUri: vscode.Uri,
    readonly testMode: boolean,
    readonly viewStates: ViewStateStore,
  ) {
    this.#settingsListener = vscode.workspace.onDidChangeConfiguration((event) => {
      if (LIVE_SETTINGS.some((section) => event.affectsConfiguration(section))) {
        for (const document of this.#documents) {
          for (const panel of document.panels) {
            panel.postSettings();
          }
        }
      }
    });
  }

  /** The focused PDF editor, if any. */
  get activePanel(): EditorPanel | undefined {
    return this.#activePanel;
  }

  get documents(): ReadonlySet<PdfDocument> {
    return this.#documents;
  }

  setHostCommandRunner(run: (command: HostCommand, panel: EditorPanel) => void): void {
    this.#runHostCommand = run;
  }

  runHostCommand(command: HostCommand, panel: EditorPanel): void {
    this.#runHostCommand(command, panel);
  }

  onStatusChange(panel: EditorPanel): void {
    this.#onDidChangePanelStatus.fire(panel);
  }

  takePendingPage(uri: vscode.Uri): number | undefined {
    const page = this.#pendingPages.get(uri.toString());
    this.#pendingPages.delete(uri.toString());
    return page;
  }

  /**
   * Opens a PDF at a page. An editor that is already open goes to the page;
   * a new one opens there (the page replaces the remembered one).
   */
  async openAtPage(uri: vscode.Uri, page: number): Promise<void> {
    const key = uri.toString();
    this.#pendingPages.set(key, page);
    // Unused (e.g. the editor was already open elsewhere): must not affect a later reload.
    setTimeout(() => {
      if (this.#pendingPages.get(key) === page) {
        this.#pendingPages.delete(key);
      }
    }, 30_000);
    await vscode.commands.executeCommand("vscode.openWith", uri, PdfEditorProvider.viewType);
    const panel = this.#activePanel;
    if (panel?.isLoaded && panel.document.uri.toString() === key) {
      this.#pendingPages.delete(key);
      panel.post({ type: "goToPage", page: String(page) });
    }
  }

  #setActivePanel(panel: EditorPanel | undefined): void {
    if (this.#activePanel !== panel) {
      this.#activePanel = panel;
      this.#onDidChangeActivePanel.fire(panel);
    }
  }

  async openCustomDocument(
    uri: vscode.Uri,
    openContext: vscode.CustomDocumentOpenContext,
    _token: vscode.CancellationToken,
  ): Promise<PdfDocument> {
    const document = await PdfDocument.create(uri, openContext.backupId);
    this.#documents.add(document);
    const changeListener = document.onDidChangeContent(() => this.#onDidChangeCustomDocument.fire({ document }));
    document.onDidDispose(() => {
      changeListener.dispose();
      this.#documents.delete(document);
    });
    return document;
  }

  async resolveCustomEditor(
    document: PdfDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken,
  ): Promise<void> {
    const panel = new EditorPanel(webviewPanel, document, this);
    document.addPanel(panel);
    if (webviewPanel.active) {
      this.#setActivePanel(panel);
    }
    const viewStateListener = webviewPanel.onDidChangeViewState(({ webviewPanel: changed }) => {
      if (changed.active) {
        this.#setActivePanel(panel);
        document.setActivePanel(panel);
      } else if (this.#activePanel === panel) {
        this.#setActivePanel(undefined);
      }
    });
    panel.onDidDispose(() => {
      viewStateListener.dispose();
      if (this.#activePanel === panel) {
        this.#setActivePanel(undefined);
      }
    });
  }

  saveCustomDocument(document: PdfDocument, cancellation: vscode.CancellationToken): Thenable<void> {
    return document.save(cancellation);
  }

  saveCustomDocumentAs(
    document: PdfDocument,
    destination: vscode.Uri,
    cancellation: vscode.CancellationToken,
  ): Thenable<void> {
    return document.saveAs(destination, cancellation);
  }

  revertCustomDocument(document: PdfDocument, cancellation: vscode.CancellationToken): Thenable<void> {
    return document.revert(cancellation);
  }

  backupCustomDocument(
    document: PdfDocument,
    context: vscode.CustomDocumentBackupContext,
    cancellation: vscode.CancellationToken,
  ): Thenable<vscode.CustomDocumentBackup> {
    return document.backup(context.destination, cancellation);
  }

  dispose(): void {
    this.#settingsListener.dispose();
    this.#onDidChangeCustomDocument.dispose();
    this.#onDidChangeActivePanel.dispose();
    this.#onDidChangePanelStatus.dispose();
  }
}
