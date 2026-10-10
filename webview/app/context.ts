import type { CursorTool, FormKind, PanelId, ViewerMode, ViewerSettings, WebviewToHost } from "../../src/shared/protocol";
import type { FindQuery, PdfEngine } from "../engine/pdfEngine";
import type { ActionRegistry } from "./actions";

/** UI state owned by the App; components read it and call actions to change it. */
export interface AppState {
  loaded: boolean;
  mode: ViewerMode;
  cursor: CursorTool;
  sidebarOpen: boolean;
  /** The panel shown in each mode (the sidebar follows the mode). */
  panels: Record<ViewerMode, PanelId>;
  fieldHighlight: boolean;
  formKind: FormKind;
  hasForm: boolean;
  requiredEmpty: number;
  find: FindQuery;
  /** Unsaved changes in any editor of the document (from the host). */
  dirty: boolean;
  /** Focus mode: floating, auto-hiding toolbar (`pdfTools.toolbar`, toggled per editor). */
  focus: boolean;
  /** Pages in the theme's colors (`pdfTools.pageColors`, toggled per editor). */
  pageColors: boolean;
  presenting: boolean;
  /** The last settings received; a change resets the per-editor toggles. */
  settings: ViewerSettings;
}

/** What UI components need from the App. */
export interface AppContext {
  readonly engine: PdfEngine;
  readonly actions: ActionRegistry;
  readonly state: AppState;
  post(message: WebviewToHost): void;
  /** Re-reads state into every component (pressed buttons, labels, …). */
  refresh(): void;
  /** Runs a find with the shared query (find widget and Search panel). */
  setFind(query: Partial<FindQuery>): void;
}
