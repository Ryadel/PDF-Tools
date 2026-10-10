// Message protocol between the extension host and the webview.
// Shared by both bundles; keep it free of runtime dependencies.
//
// The protocol is engine-agnostic: the host only deals with PDF bytes, the
// modified state, opaque field values and view settings. Everything
// PDF.js-specific lives in the webview behind the PdfEngine interface.

/** Asset URLs (webview resource URIs) the webview needs to start the engine. */
export interface WebviewConfig {
  workerUrl: string;
  standardFontDataUrl: string;
  cMapUrl: string;
  wasmUrl: string;
  iccUrl: string;
  /** VS Code's display language ("en", "it"…). */
  language: string;
  /** Translations for that language (`vscode.l10n.bundle`); none for English. */
  l10n?: Record<string, string>;
}

/**
 * A form field value change, keyed by the engine's widget id.
 * `value` is an opaque, structured-cloneable object (for PDF.js: the
 * annotation storage entry, e.g. `{ value: "text" }`).
 */
export interface FieldChange {
  id: string;
  value: unknown;
}

export type LoadReason = "open" | "revert" | "external";
export type ViewerMode = "view" | "fill";
export type ScrollModeName = "vertical" | "horizontal" | "wrapped" | "page";
export type SpreadModeName = "none" | "odd" | "even";
export type CursorTool = "select" | "hand";
export type PanelId = "thumbnails" | "outline" | "search" | "fields" | "attachments" | "layers" | "properties";
/** `floating`: Focus mode, an auto-hiding toolbar over the page. */
export type ToolbarStyle = "fixed" | "floating";
/** `theme`: pages drawn with the color theme's editor background and foreground. */
export type PageColors = "off" | "theme";
export type FormDataFormat = "json" | "xfdf";

/** Settings that change how the webview looks; sent on start and when they change. */
export interface ViewerSettings {
  toolbar: ToolbarStyle;
  pageColors: PageColors;
}

/** How a document opens: settings, then the view remembered for the file. */
export interface InitialView {
  /** `auto`: Fill when the document has editable form fields, else View. */
  mode: ViewerMode | "auto";
  /** A preset (`auto`, `page-actual`, `page-fit`, `page-width`) or a scale (`1.25`). */
  scale: string;
  page?: number;
  rotation?: number;
  scrollMode: ScrollModeName;
  spreadMode: SpreadModeName;
  cursor: CursorTool;
  sidebar: boolean;
  panel?: PanelId;
}

/** View state remembered per file (see `ViewStateStore`). */
export interface PersistedViewState {
  page: number;
  scale: string;
  rotation: number;
  scrollMode: ScrollModeName;
  spreadMode: SpreadModeName;
  sidebar: boolean;
  panel?: PanelId;
  /** Only set once the user picked a mode explicitly for this file. */
  mode?: ViewerMode;
}

/** What the status bar shows for the active editor. */
export interface ViewerStatus {
  page: number;
  pageLabel?: string;
  pageCount: number;
  /** Zoom as a factor (1 = 100%). */
  scale: number;
  /** The preset in use, if any (`page-width`, …). */
  scalePreset?: string;
  mode: ViewerMode;
  hasForm: boolean;
  changedFields: number;
  requiredEmpty: number;
  canGoBack: boolean;
  canGoForward: boolean;
}

/** Actions the webview performs on request (toolbar, menu, keys, commands). */
export type ViewerCommand =
  | "firstPage" | "lastPage" | "nextPage" | "previousPage" | "back" | "forward"
  | "zoomIn" | "zoomOut" | "zoomActual" | "zoomAuto" | "fitWidth" | "fitPage"
  | "rotateClockwise" | "rotateCounterclockwise"
  | "find" | "findNext" | "findPrevious" | "showSearch"
  | "toggleSidebar" | "showThumbnails" | "showOutline" | "showFields" | "showAttachments" | "showLayers" | "showProperties"
  | "viewMode" | "fillMode"
  | "selectTool" | "handTool"
  | "scrollVertical" | "scrollHorizontal" | "scrollWrapped" | "scrollPage"
  | "spreadNone" | "spreadOdd" | "spreadEven"
  | "toggleFieldHighlight" | "nextField" | "previousField" | "nextRequiredField" | "clearForm"
  | "toggleFocusMode" | "togglePageColors" | "presentationMode" | "copyPageImage";

/** What the host can ask the webview for (answered with a `response`). */
export type ViewerRequest =
  /** The text of every page, with page markers. */
  | { kind: "text" }
  /** A PDF with these pages (1-based) of the current document, form values included. */
  | { kind: "pages"; pages: number[] }
  /** A PNG image of one page (1-based), form values included. */
  | { kind: "pageImage"; page: number }
  | { kind: "exportForm"; format: FormDataFormat; fileName: string }
  | { kind: "importForm"; format: FormDataFormat; text: string };

/** The result type of each {@link ViewerRequest} kind. */
export interface ViewerResults {
  text: string;
  pages: Uint8Array;
  pageImage: Uint8Array;
  exportForm: string;
  importForm: FormImportResult;
}

export interface FormImportResult {
  /** Fields of this form that received a value. */
  applied: number;
  /** Names in the file that this form does not have. */
  unknown: string[];
}

export type HostToWebview =
  | { type: "load"; data: Uint8Array; fileName: string; reason: LoadReason; view: InitialView }
  | { type: "settings"; settings: ViewerSettings }
  | { type: "requestSave"; requestId: number }
  | { type: "request"; requestId: number; request: ViewerRequest }
  | { type: "saved" }
  /** The document has (or no longer has) unsaved changes, in any of its editors. */
  | { type: "dirty"; dirty: boolean }
  | { type: "applyFieldChanges"; changes: FieldChange[] }
  | { type: "notice"; level: "info" | "warning"; message: string }
  | { type: "command"; command: ViewerCommand }
  | { type: "goToPage"; page: string }
  | { type: "setScale"; value: string }
  | { type: "password"; password: string | undefined }
  // Test-only messages (handled only when the extension runs in test mode).
  | { type: "test.setFieldValues"; requestId: number; values: Record<string, string | boolean> }
  | { type: "test.getFieldValues"; requestId: number }
  | { type: "test.getProblems"; requestId: number }
  | { type: "test.getViewState"; requestId: number }
  | { type: "test.find"; requestId: number; query: string; options?: { caseSensitive?: boolean; entireWord?: boolean; matchDiacritics?: boolean } };

export type WebviewToHost =
  | { type: "ready" }
  | { type: "loaded"; pageCount: number; formKind: FormKind }
  | { type: "loadError"; message: string }
  | { type: "modified" }
  | { type: "fieldChanges"; changes: FieldChange[] }
  | { type: "saveResponse"; requestId: number; data?: Uint8Array; error?: string }
  | { type: "response"; requestId: number; result?: unknown; error?: string }
  /** Presentation mode started or ended: the host enters or leaves Zen mode. */
  | { type: "presentation"; active: boolean }
  /** Feedback for the user: `info` briefly in the status bar, `error` as a notification. */
  | { type: "showMessage"; level: "info" | "error"; message: string }
  | { type: "status"; status: ViewerStatus }
  | { type: "viewState"; state: PersistedViewState }
  | { type: "passwordRequired"; incorrect: boolean }
  | { type: "saveAttachment"; filename: string; data: Uint8Array }
  | { type: "openAttachment"; filename: string; data: Uint8Array }
  | { type: "openExternal"; url: string }
  /** Runs a `pdfTools.*` host command (prompts, confirmations) for this editor. */
  | { type: "executeCommand"; command: HostCommand }
  | { type: "log"; level: "info" | "warn" | "error"; message: string }
  | { type: "test.response"; requestId: number; result?: unknown; error?: string };

/** Host commands the webview may trigger (they need VS Code UI). */
export type HostCommand =
  | "pdfTools.save" | "pdfTools.saveAs"
  | "pdfTools.print" | "pdfTools.printPages"
  | "pdfTools.goToPage" | "pdfTools.copyPageLink"
  | "pdfTools.openText" | "pdfTools.exportPageImage"
  | "pdfTools.clearForm" | "pdfTools.exportFormData" | "pdfTools.importFormData"
  | "pdfTools.openSettings";

/** What kind of interactive form the loaded document has. */
export type FormKind = "none" | "acroform" | "xfa" | "hybrid";
