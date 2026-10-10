import type {
  FieldChange,
  FormImportResult,
  FormKind,
  ScrollModeName,
  SpreadModeName,
} from "../../src/shared/protocol";
import type { FormFieldValue, FormValue } from "../forms/formData";

/**
 * The rendering/form engine behind the webview. The UI and the extension host
 * only talk to this interface, so another engine (e.g. PDFium) could be added
 * without touching them. Types here are engine-neutral; opaque values (`dest`,
 * field values) are only passed back to the same engine.
 */
export interface PdfEngine {
  // --- Document ---------------------------------------------------------
  /** Loads a document, replacing the current one. Takes ownership of `data`. */
  load(data: Uint8Array, options: LoadOptions): Promise<LoadResult>;
  readonly pageCount: number;
  readonly view: ViewSnapshot;
  /** The page's label when the document defines labels ("iv", "A-1"). */
  pageLabel(page: number): string | undefined;
  /** Scale, page, rotation and modes applied when the next document's pages are ready. */
  setInitialView(view: { scale: string; page?: number; rotation?: number; scrollMode: ScrollModeName; spreadMode: SpreadModeName }): void;

  // --- Saving and form sync ---------------------------------------------
  /** The document bytes including every form change. */
  save(): Promise<Uint8Array>;
  /** The host saved the document: the next change must report "modified" again. */
  markSaved(): void;
  /** Applies field changes made in another editor of the same document. */
  applyFieldChanges(changes: FieldChange[]): void;

  // --- Navigation -------------------------------------------------------
  goToPage(page: number): void;
  /** Accepts a page number or a page label ("iv", "A-1"); false if unknown. */
  goToPageLabel(label: string): boolean;
  goToDestination(dest: unknown): void;
  /** 1-based page of an outline destination, or undefined. */
  getDestinationPage(dest: unknown): Promise<number | undefined>;
  back(): void;
  forward(): void;

  // --- View -------------------------------------------------------------
  zoomIn(): void;
  zoomOut(): void;
  /** A preset (`auto`, `page-actual`, `page-fit`, `page-width`) or a numeric scale (`1.5`). */
  setScale(value: string): void;
  rotate(delta: 90 | -90): void;
  setScrollMode(mode: ScrollModeName): void;
  setSpreadMode(mode: SpreadModeName): void;
  setFieldHighlight(on: boolean): void;

  // --- Panels -----------------------------------------------------------
  renderThumbnail(page: number, width: number): Promise<HTMLCanvasElement>;
  getOutline(): Promise<OutlineNode[]>;
  getAttachments(): Promise<AttachmentInfo[]>;
  getLayers(): Promise<LayerInfo[]>;
  setLayerVisible(id: string, visible: boolean): Promise<void>;
  getProperties(): Promise<DocumentProperties>;
  /** Fonts used by the document; reads every page, so it can take a while. */
  getFonts(onProgress?: (page: number, pageCount: number) => void): Promise<FontInfo[]>;

  // --- Export -----------------------------------------------------------
  /** The text of every page, each preceded by a `--- Page N ---` line. */
  getText(): Promise<string>;
  /** A new PDF with these pages (1-based), including the current form values. */
  extractPages(pages: number[]): Promise<Uint8Array>;
  /** The page as an image (2× its size, capped), with form values and the view's rotation. */
  renderPageImage(page: number): Promise<HTMLCanvasElement>;

  // --- Find -------------------------------------------------------------
  find(query: FindQuery): void;
  findAgain(previous: boolean): void;
  closeFind(): void;
  /** Selects the `matchIndex`-th match of `page` (both from `FindResults`). */
  selectMatch(page: number, matchIndex: number): void;
  getFindResults(contextChars: number): Promise<FindResults>;

  // --- Forms ------------------------------------------------------------
  /** Widgets of the document's form, in page order (empty without a form). */
  getFormFields(): Promise<FormFieldInfo[]>;
  focusField(id: string): Promise<void>;
  /** Sets every field to its default value (usually empty). */
  clearForm(): Promise<void>;
  readonly changedFieldIds: ReadonlySet<string>;
  /** Current values by fully qualified field name (buttons and signatures excluded). */
  getFormValues(): Promise<FormFieldValue[]>;
  /** Sets fields by name (form data import); read-only fields are left alone. */
  setFormValues(values: ReadonlyMap<string, FormValue>): Promise<FormImportResult>;

  // --- Test support -----------------------------------------------------
  setFieldValuesByName(values: Record<string, string | boolean>): Promise<{ viaDom: string[]; viaStorage: string[] }>;
  getFieldValuesByName(): Promise<{ values: Record<string, unknown>; renderedWidgets: number }>;
}

export interface LoadOptions {
  /** Asked when the document is encrypted with a user password; undefined cancels. */
  getPassword(incorrect: boolean): Promise<string | undefined>;
}

export interface LoadResult {
  pageCount: number;
  formKind: FormKind;
  /** At least one visible, editable form field (drives the `auto` mode). */
  hasEditableFields: boolean;
}

export interface ViewSnapshot {
  page: number;
  pageLabel?: string;
  scale: number;
  /** The preset in use (`auto`, `page-width`, …) or the numeric scale as text. */
  scaleValue: string;
  rotation: number;
  scrollMode: ScrollModeName;
  spreadMode: SpreadModeName;
  canGoBack: boolean;
  canGoForward: boolean;
}

export interface PdfEngineEvents {
  /** The first form change since the document was loaded or saved. */
  onModified(): void;
  /** Field values changed by the user in this editor. */
  onFieldChanges(changes: FieldChange[]): void;
  /** Page, zoom, rotation, scroll/spread mode or history changed. */
  onViewChange(): void;
  onFindChange(state: FindState): void;
  /** The pages finished rendering their form widgets (after load / scroll). */
  onFormRendered(): void;
}

export interface OutlineNode {
  title: string;
  bold: boolean;
  italic: boolean;
  dest: unknown;
  url?: string;
  items: OutlineNode[];
}

export interface AttachmentInfo {
  filename: string;
  description?: string;
  data: Uint8Array;
}

export interface LayerInfo {
  id: string;
  name: string;
  visible: boolean;
  depth: number;
}

export interface DocumentProperties {
  fields: [label: string, value: string][];
}

export interface FontInfo {
  /** Without the subset prefix ("ABCDEF+"). */
  name: string;
  /** "TrueType", "Type1", "Type3", "CIDFontType2"… */
  type: string;
  embedded: boolean;
  /** Only the glyphs the document uses are embedded. */
  subset: boolean;
}

export interface FindQuery {
  query: string;
  caseSensitive: boolean;
  entireWord: boolean;
  matchDiacritics: boolean;
  highlightAll: boolean;
}

export interface FindState {
  status: "idle" | "pending" | "found" | "notFound" | "wrapped";
  current: number;
  total: number;
}

export interface FindResults {
  query: string;
  /** Pages whose text has been searched so far. */
  pagesSearched: number;
  total: number;
  pages: { page: number; pageLabel?: string; matches: { index: number; before: string; match: string; after: string }[] }[];
}

export interface FormFieldInfo {
  id: string;
  name: string;
  type: "text" | "checkbox" | "radio" | "choice" | "button" | "signature";
  page: number;
  value: string;
  required: boolean;
  readOnly: boolean;
}
