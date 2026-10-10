import type * as vscode from "vscode";
import type { PersistedViewState } from "../shared/protocol";

const STORAGE_KEY = "pdfTools.viewStates";
/** Least recently used entries beyond this are forgotten. */
const MAX_ENTRIES = 300;

type Entries = Record<string, PersistedViewState & { usedAt: number }>;

/**
 * Remembers page, zoom, rotation, scroll/spread mode, sidebar and the chosen
 * mode per file, across sessions (global state: files may be outside any
 * workspace).
 */
export class ViewStateStore {
  constructor(private readonly memento: vscode.Memento) {}

  get(uri: vscode.Uri): PersistedViewState | undefined {
    const entry = this.#entries()[uri.toString()];
    if (!entry) {
      return undefined;
    }
    const { usedAt: _usedAt, ...state } = entry;
    return state;
  }

  async set(uri: vscode.Uri, state: PersistedViewState): Promise<void> {
    const entries = { ...this.#entries(), [uri.toString()]: { ...state, usedAt: Date.now() } };
    const keys = Object.keys(entries);
    if (keys.length > MAX_ENTRIES) {
      keys
        .sort((a, b) => entries[a].usedAt - entries[b].usedAt)
        .slice(0, keys.length - MAX_ENTRIES)
        .forEach((key) => delete entries[key]);
    }
    await this.memento.update(STORAGE_KEY, entries);
  }

  #entries(): Entries {
    return this.memento.get<Entries>(STORAGE_KEY, {});
  }
}
