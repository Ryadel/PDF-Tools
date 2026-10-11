import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import * as vscode from "vscode";
import { errorMessage, log } from "../log";
import { initialView, viewerSettings } from "../settings";
import { ATTACHMENT_TEMP_FOLDER, deleteOldTempFiles } from "../tempFiles";
import { takeTestPassword } from "../testing/testCommands";
import type {
  FormKind,
  HostCommand,
  HostToWebview,
  LoadReason,
  ViewerRequest,
  ViewerResults,
  ViewerStatus,
  WebviewToHost,
} from "../shared/protocol";
import type { PdfDocument } from "./pdfDocument";
import type { ViewStateStore } from "./viewStateStore";
import { getWebviewHtml, webviewRoot } from "./webviewHtml";

const EXTERNAL_SCHEMES = new Set(["http", "https", "mailto"]);

/** What the provider needs from a panel's owner, kept narrow on purpose. */
export interface EditorPanelHost {
  readonly extensionUri: vscode.Uri;
  readonly testMode: boolean;
  readonly viewStates: ViewStateStore;
  /** Runs a command that needs VS Code UI (print, prompts) for this editor. */
  runHostCommand(command: HostCommand, panel: EditorPanel): void;
  /** The panel reported a new status (page, zoom, mode…). */
  onStatusChange(panel: EditorPanel): void;
  /** A page to open the document at (from a "Copy Link to This Page" link), consumed once. */
  takePendingPage(uri: vscode.Uri): number | undefined;
}

/** Observable state of a panel, used by the integration tests. */
export interface EditorPanelState {
  loadCount: number;
  pageCount: number;
  formKind: FormKind | undefined;
  lastError: string | undefined;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(reason: Error): void;
  timer: NodeJS.Timeout;
}

/** One webview showing a {@link PdfDocument}. A document may have several. */
export class EditorPanel implements vscode.Disposable {
  readonly state: EditorPanelState = { loadCount: 0, pageCount: 0, formKind: undefined, lastError: undefined };
  /** Last status reported by the webview (status bar). */
  status: ViewerStatus | undefined;

  #ready = false;
  #loaded = false;
  #disposed = false;
  #presenting = false;
  #nextRequestId = 1;
  readonly #requests = new Map<number, PendingRequest>();
  readonly #disposables: vscode.Disposable[] = [];
  readonly #onDidDispose = new vscode.EventEmitter<void>();
  readonly onDidDispose = this.#onDidDispose.event;

  constructor(
    readonly webviewPanel: vscode.WebviewPanel,
    readonly document: PdfDocument,
    private readonly host: EditorPanelHost,
  ) {
    const { webview } = webviewPanel;
    webview.options = {
      enableScripts: true,
      localResourceRoots: [webviewRoot(host.extensionUri)],
    };
    webview.html = getWebviewHtml(webview, host.extensionUri);
    this.#disposables.push(
      webview.onDidReceiveMessage((message: WebviewToHost) => this.#onMessage(message)),
      webviewPanel.onDidDispose(() => this.dispose()),
    );
  }

  /** True once the webview has finished loading the current document bytes. */
  get isLoaded(): boolean {
    return this.#loaded && !this.#disposed;
  }

  post(message: HostToWebview): void {
    if (!this.#disposed) {
      void this.webviewPanel.webview.postMessage(message);
    }
  }

  /** Sends the document's current bytes to the webview. */
  load(reason: LoadReason): void {
    if (!this.#ready) {
      return; // The webview loads the document as soon as it reports "ready".
    }
    this.#loaded = false;
    // A copy as a plain Uint8Array: `workspace.fs.readFile` returns a Node
    // Buffer, which webview messaging does not send as binary data (and whose
    // slice() would share memory).
    const data = new Uint8Array(this.document.bytes);
    const view = initialView(this.host.viewStates.get(this.document.uri));
    const page = this.host.takePendingPage(this.document.uri);
    if (page !== undefined) {
      view.page = page;
    }
    this.post({ type: "load", data, fileName: this.document.fileName, reason, view });
  }

  /** Sends the settings the webview follows live (toolbar style, page colors). */
  postSettings(): void {
    this.post({ type: "settings", settings: viewerSettings() });
  }

  /** Asks the webview for the document bytes including all form changes. */
  requestBytes(timeoutMs: number): Promise<Uint8Array> {
    return this.#request<Uint8Array>((requestId) => ({ type: "requestSave", requestId }), timeoutMs);
  }

  /** Asks the webview for text, pages, an image or form data (see `ViewerRequest`). */
  request<K extends ViewerRequest["kind"]>(request: Extract<ViewerRequest, { kind: K }>, timeoutMs = 120_000): Promise<ViewerResults[K]> {
    return this.#request<ViewerResults[K]>((requestId) => ({ type: "request", requestId, request }), timeoutMs);
  }

  /** Test-only round trip; see `src/testing/testCommands.ts`. */
  requestTest(message: (requestId: number) => HostToWebview, timeoutMs = 10_000): Promise<unknown> {
    return this.#request(message, timeoutMs);
  }

  #request<T>(build: (requestId: number) => HostToWebview, timeoutMs: number): Promise<T> {
    if (!this.isLoaded) {
      return Promise.reject(new Error(vscode.l10n.t("The PDF is not loaded in this editor.")));
    }
    const requestId = this.#nextRequestId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#requests.delete(requestId);
        reject(new Error(vscode.l10n.t("The PDF viewer did not respond within {0} seconds.", timeoutMs / 1000)));
      }, timeoutMs);
      this.#requests.set(requestId, { resolve: resolve as (value: unknown) => void, reject, timer });
      this.post(build(requestId));
    });
  }

  #settle(requestId: number, error: string | undefined, value: unknown): void {
    const request = this.#requests.get(requestId);
    if (!request) {
      return; // Timed out already.
    }
    this.#requests.delete(requestId);
    clearTimeout(request.timer);
    if (error !== undefined) {
      request.reject(new Error(error));
    } else {
      request.resolve(value);
    }
  }

  #onMessage(message: WebviewToHost): void {
    switch (message.type) {
      case "ready":
        this.#ready = true;
        this.postSettings();
        this.load("open");
        break;
      case "loaded":
        this.#loaded = true;
        this.state.loadCount++;
        this.state.pageCount = message.pageCount;
        this.state.formKind = message.formKind;
        this.state.lastError = undefined;
        this.document.handlePanelLoaded(this);
        break;
      case "loadError":
        this.state.lastError = message.message;
        log().error(`Failed to load ${this.document.uri.toString(true)}: ${message.message}`);
        break;
      case "modified":
        this.document.handleModified(this);
        break;
      case "fieldChanges":
        this.document.handleFieldChanges(this, message.changes);
        break;
      case "saveResponse":
        this.#settle(message.requestId, message.error, message.data);
        break;
      case "response":
        this.#settle(message.requestId, message.error, message.result);
        break;
      case "presentation":
        void this.#setPresentation(message.active);
        break;
      case "showMessage":
        if (message.level === "error") {
          void vscode.window.showErrorMessage(message.message);
        } else {
          vscode.window.setStatusBarMessage(message.message, 4_000);
        }
        break;
      case "status":
        this.status = message.status;
        this.host.onStatusChange(this);
        break;
      case "viewState":
        void this.host.viewStates.set(this.document.uri, message.state);
        break;
      case "passwordRequired":
        void this.#askPassword(message.incorrect);
        break;
      case "saveAttachment":
        void this.#saveAttachment(message.filename, message.data);
        break;
      case "openAttachment":
        void this.#openAttachment(message.filename, message.data);
        break;
      case "openExternal":
        this.#openExternal(message.url);
        break;
      case "executeCommand":
        this.host.runHostCommand(message.command, this);
        break;
      case "log":
        log()[message.level](`[webview] ${message.message}`);
        break;
      case "test.response":
        if (this.host.testMode) {
          this.#settle(message.requestId, message.error, message.result);
        }
        break;
    }
  }

  async #askPassword(incorrect: boolean): Promise<void> {
    // Integration tests cannot type into the input box: they provide the answer.
    const testPassword = this.host.testMode ? takeTestPassword() : undefined;
    const password = testPassword ?? await vscode.window.showInputBox({
      title: vscode.l10n.t("Password for {0}", this.document.fileName),
      prompt: incorrect
        ? vscode.l10n.t("Incorrect password. Try again.")
        : vscode.l10n.t("This PDF is protected by a password."),
      password: true,
      ignoreFocusOut: true,
    });
    this.post({ type: "password", password });
  }

  async #saveAttachment(filename: string, data: Uint8Array): Promise<void> {
    const target = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.joinPath(this.document.uri, "..", safeFileName(filename)),
      title: vscode.l10n.t("Save Attachment"),
    });
    if (target) {
      try {
        await vscode.workspace.fs.writeFile(target, data);
      } catch (error) {
        void vscode.window.showErrorMessage(vscode.l10n.t("Could not save {0}: {1}", filename, errorMessage(error)));
      }
    }
  }

  /** Opens an attachment in VS Code (PDFs open in PDF Tools) from a temporary copy, deleted after a day. */
  async #openAttachment(filename: string, data: Uint8Array): Promise<void> {
    void deleteOldTempFiles();
    try {
      const folder = join(ATTACHMENT_TEMP_FOLDER, String(Date.now()));
      await mkdir(folder, { recursive: true });
      const file = join(folder, safeFileName(filename));
      await writeFile(file, data);
      await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(file));
    } catch (error) {
      void vscode.window.showErrorMessage(vscode.l10n.t("Could not open {0}: {1}", filename, errorMessage(error)));
    }
  }

  /**
   * Presentation mode = Zen mode (full screen by default, `zenMode.fullScreen`).
   * Extensions cannot read whether Zen mode is on, and there is only a toggle;
   * `exitZenMode` does nothing outside Zen mode, so exit + toggle always enters.
   */
  async #setPresentation(active: boolean): Promise<void> {
    this.#presenting = active;
    if (this.host.testMode) {
      return; // Tests check the webview side; Zen mode would reshape the test window.
    }
    try {
      await vscode.commands.executeCommand("workbench.action.exitZenMode");
      if (active) {
        await vscode.commands.executeCommand("workbench.action.toggleZenMode");
      }
    } catch (error) {
      log().warn(`Zen mode command failed: ${errorMessage(error)}`);
    }
  }

  #openExternal(url: string): void {
    let uri: vscode.Uri;
    try {
      uri = vscode.Uri.parse(url, true);
    } catch {
      return;
    }
    if (EXTERNAL_SCHEMES.has(uri.scheme)) {
      void vscode.env.openExternal(uri);
    } else {
      log().warn(`Blocked link with scheme "${uri.scheme}" in ${this.document.uri.toString(true)}`);
    }
  }

  dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    if (this.#presenting) {
      void this.#setPresentation(false);
    }
    for (const request of this.#requests.values()) {
      clearTimeout(request.timer);
      request.reject(new Error(vscode.l10n.t("The editor was closed.")));
    }
    this.#requests.clear();
    this.#onDidDispose.fire();
    this.#onDidDispose.dispose();
    for (const disposable of this.#disposables) {
      disposable.dispose();
    }
  }
}

/** A plain file name, without any path an attachment name might carry. */
function safeFileName(name: string): string {
  // eslint-disable-next-line no-control-regex -- control characters are invalid in file names
  const base = basename(name.split("\\").join("/")).replace(/[<>:"|?*\u0000-\u001f]/g, "_").trim();
  return base && base !== "." && base !== ".." ? base : "attachment";
}
