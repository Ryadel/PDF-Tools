import { posix } from "node:path";
import * as vscode from "vscode";
import { errorMessage, log } from "../log";
import type { FieldChange } from "../shared/protocol";
import type { EditorPanel } from "./editorPanel";

/** Generous: saving re-serializes the whole document in the PDF.js worker. */
const SAVE_TIMEOUT_MS = 60_000;
/** Coalesces the bursts of change events a single external write produces. */
const DISK_CHANGE_DEBOUNCE_MS = 300;

/**
 * The model behind one PDF file, shared by all the editors (webview panels)
 * open on it.
 *
 * The host keeps the bytes last read from or written to disk; the form state
 * lives in the webviews. Saving asks one panel for the serialized document.
 * Field changes made in one panel are relayed to the others, and remembered so
 * that a panel opened later can catch up.
 */
export class PdfDocument implements vscode.CustomDocument {
  static async create(uri: vscode.Uri, backupId: string | undefined): Promise<PdfDocument> {
    // When restoring after a restart (hot exit), load the backup instead of the
    // file. VS Code marks a document restored from a backup as dirty.
    const source = backupId ? vscode.Uri.parse(backupId) : uri;
    const bytes = await vscode.workspace.fs.readFile(source);
    const document = new PdfDocument(uri, bytes, backupId !== undefined);
    await document.#recordDiskState();
    return document;
  }

  readonly #panels = new Set<EditorPanel>();
  #lastActivePanel: EditorPanel | undefined;
  /** Unsaved field values by widget id, replayed to panels that load later. */
  readonly #unsavedFieldValues = new Map<string, unknown>();
  #bytes: Uint8Array;
  #dirty: boolean;
  #diskMtime: number | undefined;
  #saving = 0;
  #modifiedWhileSaving = false;
  #diskChangeTimer: NodeJS.Timeout | undefined;
  #handlingDiskChange = false;
  readonly #disposables: vscode.Disposable[] = [];

  readonly #onDidChangeContent = new vscode.EventEmitter<void>();
  /** Fires when the form state changes: the provider turns it into a dirty edit. */
  readonly onDidChangeContent = this.#onDidChangeContent.event;
  readonly #onDidDispose = new vscode.EventEmitter<void>();
  readonly onDidDispose = this.#onDidDispose.event;

  private constructor(
    readonly uri: vscode.Uri,
    bytes: Uint8Array,
    restoredFromBackup: boolean,
  ) {
    this.#bytes = bytes;
    this.#dirty = restoredFromBackup;
    this.#watchDisk();
  }

  get fileName(): string {
    return posix.basename(this.uri.path);
  }

  /** The bytes webviews load: the file on disk, or a restored backup. */
  get bytes(): Uint8Array {
    return this.#bytes;
  }

  get panels(): ReadonlySet<EditorPanel> {
    return this.#panels;
  }

  addPanel(panel: EditorPanel): void {
    this.#panels.add(panel);
    this.#lastActivePanel ??= panel;
    panel.onDidDispose(() => {
      this.#panels.delete(panel);
      if (this.#lastActivePanel === panel) {
        this.#lastActivePanel = this.#panels.values().next().value;
      }
    });
  }

  setActivePanel(panel: EditorPanel): void {
    this.#lastActivePanel = panel;
  }

  // --- Events from panels -------------------------------------------------

  handlePanelLoaded(panel: EditorPanel): void {
    if (this.#unsavedFieldValues.size > 0) {
      const changes = [...this.#unsavedFieldValues].map(([id, value]) => ({ id, value }));
      panel.post({ type: "applyFieldChanges", changes });
    }
    panel.post({ type: "dirty", dirty: this.#dirty });
  }

  handleModified(): void {
    if (this.#saving > 0) {
      // Report it once the save has completed, or VS Code would clear it.
      this.#modifiedWhileSaving = true;
      return;
    }
    this.#setDirty(true);
    this.#onDidChangeContent.fire();
  }

  /** Keeps the panels' Save button in step with VS Code's dirty state. */
  #setDirty(dirty: boolean): void {
    if (this.#dirty !== dirty) {
      this.#dirty = dirty;
      for (const panel of this.#panels) {
        panel.post({ type: "dirty", dirty });
      }
    }
  }

  handleFieldChanges(source: EditorPanel, changes: FieldChange[]): void {
    for (const { id, value } of changes) {
      this.#unsavedFieldValues.set(id, value);
    }
    for (const panel of this.#panels) {
      if (panel !== source) {
        panel.post({ type: "applyFieldChanges", changes });
      }
    }
  }

  // --- Save, revert, backup -----------------------------------------------

  /**
   * The document bytes including every form change. Prefers the given panel,
   * then the most recently active one; without a loaded panel the document
   * has no unsaved form state and the stored bytes are current.
   */
  async getCurrentBytes(preferred?: EditorPanel): Promise<Uint8Array> {
    const candidates = [preferred, this.#lastActivePanel, ...this.#panels];
    const panel = candidates.find((candidate) => candidate?.isLoaded);
    return panel ? panel.requestBytes(SAVE_TIMEOUT_MS) : this.#bytes;
  }

  async save(cancellation: vscode.CancellationToken): Promise<void> {
    await this.#saveTo(this.uri, cancellation, true);
  }

  async saveAs(destination: vscode.Uri, cancellation: vscode.CancellationToken): Promise<void> {
    await this.#saveTo(destination, cancellation, false);
  }

  async #saveTo(target: vscode.Uri, cancellation: vscode.CancellationToken, isSave: boolean): Promise<void> {
    this.#saving++;
    try {
      const data = await this.getCurrentBytes();
      if (cancellation.isCancellationRequested) {
        throw new vscode.CancellationError();
      }
      await vscode.workspace.fs.writeFile(target, data);
      if (isSave) {
        this.#bytes = data;
        this.#setDirty(false);
        this.#unsavedFieldValues.clear();
        await this.#recordDiskState();
        for (const panel of this.#panels) {
          panel.post({ type: "saved" });
        }
      }
    } finally {
      this.#saving--;
      if (this.#saving === 0 && this.#modifiedWhileSaving) {
        this.#modifiedWhileSaving = false;
        // After VS Code has processed the save result, so the edit is not lost.
        setTimeout(() => this.handleModified(), 0);
      }
    }
  }

  async revert(_cancellation: vscode.CancellationToken): Promise<void> {
    await this.#reloadFromDisk("revert");
  }

  async backup(destination: vscode.Uri, cancellation: vscode.CancellationToken): Promise<vscode.CustomDocumentBackup> {
    const data = await this.getCurrentBytes();
    if (cancellation.isCancellationRequested) {
      throw new vscode.CancellationError();
    }
    await vscode.workspace.fs.writeFile(destination, data);
    return {
      id: destination.toString(),
      delete: async () => {
        try {
          await vscode.workspace.fs.delete(destination);
        } catch {
          // Already gone.
        }
      },
    };
  }

  async #reloadFromDisk(reason: "revert" | "external"): Promise<void> {
    this.#bytes = await vscode.workspace.fs.readFile(this.uri);
    this.#setDirty(false);
    this.#unsavedFieldValues.clear();
    await this.#recordDiskState();
    for (const panel of this.#panels) {
      panel.load(reason);
    }
  }

  // --- External changes ---------------------------------------------------

  #watchDisk(): void {
    let watcher: vscode.FileSystemWatcher;
    try {
      const folder = vscode.Uri.joinPath(this.uri, "..");
      watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, this.fileName));
    } catch (error) {
      log().warn(`Cannot watch ${this.uri.toString(true)} for changes: ${errorMessage(error)}`);
      return;
    }
    const schedule = () => {
      clearTimeout(this.#diskChangeTimer);
      this.#diskChangeTimer = setTimeout(() => void this.#onDiskChange(), DISK_CHANGE_DEBOUNCE_MS);
    };
    this.#disposables.push(watcher, watcher.onDidChange(schedule), watcher.onDidCreate(schedule));
  }

  async #recordDiskState(): Promise<void> {
    try {
      this.#diskMtime = (await vscode.workspace.fs.stat(this.uri)).mtime;
    } catch {
      this.#diskMtime = undefined;
    }
  }

  async #onDiskChange(): Promise<void> {
    if (this.#saving > 0 || this.#handlingDiskChange) {
      return;
    }
    let mtime: number;
    try {
      mtime = (await vscode.workspace.fs.stat(this.uri)).mtime;
    } catch {
      return; // Deleted or unreachable: keep the open state.
    }
    if (mtime === this.#diskMtime) {
      return; // Our own write.
    }
    this.#diskMtime = mtime;
    this.#handlingDiskChange = true;
    try {
      if (!this.#dirty) {
        log().info(`${this.uri.toString(true)} changed on disk; reloading.`);
        await this.#reloadFromDisk("external");
        return;
      }
      const reload = vscode.l10n.t("Reload");
      const choice = await vscode.window.showWarningMessage(
        vscode.l10n.t("'{0}' has changed on disk. Reload it and discard your unsaved changes?", this.fileName),
        reload,
        vscode.l10n.t("Keep My Changes"),
      );
      if (choice === reload) {
        await this.#revertThroughVSCode();
      }
    } catch (error) {
      log().error(`Failed to handle an external change to ${this.uri.toString(true)}: ${errorMessage(error)}`);
    } finally {
      this.#handlingDiskChange = false;
    }
  }

  /**
   * Reverts through VS Code, so that it also clears the dirty state. The
   * revert command only acts on the active editor (it takes no URI), so one of
   * this document's panels must become active first.
   */
  async #revertThroughVSCode(): Promise<void> {
    const panel = (this.#lastActivePanel ?? this.#panels.values().next().value)?.webviewPanel;
    if (!panel) {
      await this.#reloadFromDisk("external");
      return;
    }
    if (!panel.active) {
      const activated = new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          subscription.dispose();
          resolve();
        }, 2_000);
        const subscription = panel.onDidChangeViewState(({ webviewPanel }) => {
          if (webviewPanel.active) {
            clearTimeout(timer);
            subscription.dispose();
            resolve();
          }
        });
      });
      panel.reveal();
      await activated;
    }
    if (panel.active) {
      await vscode.commands.executeCommand("workbench.action.files.revert");
    } else {
      void vscode.window.showWarningMessage(
        vscode.l10n.t("Could not reload '{0}'. Use File: Revert File on its editor.", this.fileName),
      );
    }
  }

  dispose(): void {
    clearTimeout(this.#diskChangeTimer);
    this.#onDidDispose.fire();
    for (const disposable of [...this.#disposables, this.#onDidChangeContent, this.#onDidDispose]) {
      disposable.dispose();
    }
  }
}
