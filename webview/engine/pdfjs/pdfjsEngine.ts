import "./pdfjsGlobal"; // Must precede the pdf_viewer import.
import {
  AnnotationMode,
  getDocument,
  GlobalWorkerOptions,
  OPS,
  PasswordResponses,
  type PDFDocumentLoadingTask,
  type PDFDocumentProxy,
  type PDFPageProxy,
} from "pdfjs-dist";
import {
  EventBus,
  PDFFindController,
  PDFLinkService,
  PDFViewer,
  ScrollMode,
  SpreadMode,
} from "pdfjs-dist/web/pdf_viewer.mjs";
import type { FieldChange, FormImportResult, FormKind, ScrollModeName, SpreadModeName, WebviewConfig } from "../../../src/shared/protocol";
import { type FormFieldValue, type FormValue, isOff } from "../../forms/formData";
import type {
  AttachmentInfo,
  DocumentProperties,
  FindQuery,
  FindResults,
  FindState,
  FontInfo,
  FormFieldInfo,
  LayerInfo,
  LoadOptions,
  LoadResult,
  OutlineNode,
  PdfEngine,
  PdfEngineEvents,
  ViewSnapshot,
} from "../pdfEngine";
import { t } from "../../l10n";
import { NavigationHistory } from "./history";
import { describeDate, describeSize } from "./format";
import { startPdfjsWorker } from "./worker";

type AnnotationStorage = PDFDocumentProxy["annotationStorage"];

/** A widget as returned by `PDFDocumentProxy.getFieldObjects()` (subset). */
interface FieldObject {
  id: string;
  type: string;
  value: unknown;
  exportValues?: string;
  editable?: boolean;
  hidden?: boolean;
}

/** A widget annotation as returned by `PDFPageProxy.getAnnotations()` (subset). */
interface WidgetAnnotation {
  id: string;
  subtype: string;
  fieldName?: string;
  fieldType?: "Tx" | "Btn" | "Ch" | "Sig";
  fieldValue?: unknown;
  defaultFieldValue?: unknown;
  exportValue?: string;
  buttonValue?: string;
  checkBox?: boolean;
  radioButton?: boolean;
  pushButton?: boolean;
  readOnly?: boolean;
  required?: boolean;
  hidden?: boolean;
  rect: number[];
}

const SCROLL_MODES: Record<ScrollModeName, number> = {
  vertical: ScrollMode.VERTICAL,
  horizontal: ScrollMode.HORIZONTAL,
  wrapped: ScrollMode.WRAPPED,
  page: ScrollMode.PAGE,
};
const SPREAD_MODES: Record<SpreadModeName, number> = { none: SpreadMode.NONE, odd: SpreadMode.ODD, even: SpreadMode.EVEN };
/** Zoom presets that depend on the container size, re-applied when it changes. */
const FITTING_SCALES = new Set(["auto", "page-fit", "page-width"]);
/** Page images: 2× (144 dpi), but at most this many pixels (large maps, posters). */
const PAGE_IMAGE_SCALE = 2;
const PAGE_IMAGE_MAX_PIXELS = 16_000_000;

export class PdfjsEngine implements PdfEngine {
  static async create(config: WebviewConfig, container: HTMLDivElement, events: PdfEngineEvents): Promise<PdfjsEngine> {
    GlobalWorkerOptions.workerPort = await startPdfjsWorker(config.workerUrl);
    return new PdfjsEngine(config, container, events);
  }

  readonly #eventBus = new EventBus();
  readonly #linkService: PDFLinkService;
  readonly #findController: PDFFindController;
  readonly #viewer: PDFViewer;
  readonly #history: NavigationHistory;
  #document: PDFDocumentProxy | undefined;
  #loadingTask: PDFDocumentLoadingTask | undefined;
  /** Kept in memory to open the document a second time (font list). */
  #password: string | undefined;
  #byteLength = 0;
  #pageLabels: string[] | null = null;
  /** Form widgets (collected once per document) and their raw annotation data. */
  #formWidgets: Promise<Map<string, { info: Omit<FormFieldInfo, "value">; raw: WidgetAnnotation }>> | undefined;
  #initialView: { scale: string; page?: number; rotation: number; scrollMode: ScrollModeName; spreadMode: SpreadModeName } = {
    scale: "auto",
    rotation: 0,
    scrollMode: "vertical",
    spreadMode: "none",
  };
  #applyingRemoteChanges = false;
  #saving = false;
  #changedWhileSaving = false;
  readonly #pendingChanges = new Map<string, unknown>();
  readonly #changedFieldIds = new Set<string>();
  #findQuery: FindQuery | undefined;
  /** Page text as PDF.js's find controller builds it (its match offsets refer to it). */
  readonly #pageTexts = new Map<number, Promise<PageText>>();

  private constructor(
    private readonly config: WebviewConfig,
    private readonly container: HTMLDivElement,
    private readonly events: PdfEngineEvents,
  ) {
    this.#linkService = new PDFLinkService({ eventBus: this.#eventBus });
    this.#findController = new PDFFindController({
      linkService: this.#linkService,
      eventBus: this.#eventBus,
      updateMatchesCountOnProgress: true,
    });
    this.#viewer = new PDFViewer({
      container,
      eventBus: this.#eventBus,
      linkService: this.#linkService,
      findController: this.#findController,
      annotationMode: AnnotationMode.ENABLE_FORMS,
      supportsPinchToZoom: true,
    });
    this.#linkService.setViewer(this.#viewer);
    // PDFViewer wires findController.onIsPageVisible itself.
    this.#history = new NavigationHistory(this.#viewer, container, () => events.onViewChange());
    this.#linkService.setHistory(this.#history);

    const bus = this.#eventBus;
    bus.on("pagesinit", () => {
      // PDFViewer resets rotation and scroll/spread modes for each new document,
      // so the initial view is applied once its pages exist.
      const { scale, page, rotation, scrollMode, spreadMode } = this.#initialView;
      this.#viewer.pagesRotation = rotation;
      this.#viewer.scrollMode = SCROLL_MODES[scrollMode];
      this.#viewer.spreadMode = SPREAD_MODES[spreadMode];
      this.#viewer.currentScaleValue = scale;
      if (page && page <= this.#viewer.pagesCount) {
        this.#viewer.currentPageNumber = page;
      }
      events.onViewChange();
    });
    for (const name of ["pagechanging", "scalechanging", "rotationchanging", "scrollmodechanged", "spreadmodechanged"]) {
      bus.on(name, () => events.onViewChange());
    }
    bus.on("annotationlayerrendered", () => events.onFormRendered());
    bus.on("updatefindmatchescount", () => events.onFindChange(this.#findState()));
    bus.on("updatefindcontrolstate", () => events.onFindChange(this.#findState()));

    // PDFViewer computes "auto", "page-fit" and "page-width" once; the generic
    // viewer re-applies them on window resize. Do the same when the container
    // changes size (sidebar, Focus mode, presentation, editor resized).
    let frame = 0;
    new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const viewer = this.#viewer;
        const value = viewer.currentScaleValue;
        if (viewer.pagesCount > 0 && FITTING_SCALES.has(value)) {
          // The re-fit scrolls back to the last *computed* location, which lags
          // behind a page change made just before (the remembered page at load),
          // and is not computed at all while the container has no height yet:
          // refresh it, and return to the page if the re-fit moved away from it.
          const page = viewer.currentPageNumber;
          viewer.update();
          viewer.currentScaleValue = value;
          if (viewer.currentPageNumber !== page) {
            viewer.currentPageNumber = page;
          }
        }
      });
      // Border box: a scrollbar appearing after the re-fit must not trigger another.
    }).observe(container, { box: "border-box" });
  }

  // --- Document -----------------------------------------------------------

  async load(data: Uint8Array, options: LoadOptions): Promise<LoadResult> {
    if (this.#document) {
      this.#viewer.setDocument(null as unknown as PDFDocumentProxy);
      this.#linkService.setDocument(null);
      this.#findController.setDocument(null as unknown as PDFDocumentProxy);
      this.#document = undefined;
    }
    await this.#loadingTask?.destroy();
    this.#pendingChanges.clear();
    this.#changedFieldIds.clear();
    this.#formWidgets = undefined;
    this.#pageTexts.clear();
    this.#history.reset();
    this.#password = undefined;
    this.#byteLength = data.byteLength;

    const task = getDocument({
      data,
      cMapUrl: this.config.cMapUrl,
      standardFontDataUrl: this.config.standardFontDataUrl,
      wasmUrl: this.config.wasmUrl,
      iccUrl: this.config.iccUrl,
      // The worker cannot fetch webview resources (different origin): the
      // main thread fetches fonts, CMaps and WASM and hands them over.
      useWorkerFetch: false,
      enableXfa: false,
    });
    let passwordCancelled = false;
    task.onPassword = (updatePassword: (password: string) => void, reason: number) => {
      void options.getPassword(reason === PasswordResponses.INCORRECT_PASSWORD).then((password) => {
        if (password === undefined) {
          passwordCancelled = true;
          void task.destroy();
        } else {
          this.#password = password;
          updatePassword(password);
        }
      });
    };
    this.#loadingTask = task;

    let document: PDFDocumentProxy;
    try {
      document = await task.promise;
    } catch (error) {
      if (passwordCancelled) {
        throw Object.assign(new Error(t("A password is required to open this PDF.")), { name: "PasswordCancelled" });
      }
      throw error;
    }
    this.#document = document;
    this.#trackFormChanges(document.annotationStorage);

    const [labels, formKind, hasEditableFields] = await Promise.all([
      document.getPageLabels(),
      detectFormKind(document),
      detectEditableFields(document),
    ]);
    this.#pageLabels = labels && labels.some((label, index) => label !== String(index + 1)) ? labels : null;

    // Not findController.setDocument(): PDFViewer calls it once the first page
    // has rendered, and a second call resets the controller, dropping any
    // search started in between (e.g. the find widget's query after a reload).
    this.#viewer.setDocument(document);
    this.#linkService.setDocument(document);
    this.#viewer.setPageLabels(this.#pageLabels);
    return { pageCount: document.numPages, formKind, hasEditableFields };
  }

  /** Scale and page applied when the next document's pages are ready. */
  setInitialView(view: { scale: string; page?: number; rotation?: number; scrollMode: ScrollModeName; spreadMode: SpreadModeName }): void {
    this.#initialView = {
      scale: view.scale,
      page: view.page,
      rotation: normalizeRotation(view.rotation ?? 0),
      scrollMode: view.scrollMode,
      spreadMode: view.spreadMode,
    };
  }

  get pageCount(): number {
    return this.#document?.numPages ?? 0;
  }

  get view(): ViewSnapshot {
    const viewer = this.#viewer;
    const page = viewer.currentPageNumber;
    return {
      page,
      pageLabel: this.#pageLabels?.[page - 1],
      scale: viewer.currentScale,
      scaleValue: viewer.currentScaleValue ?? String(viewer.currentScale),
      rotation: viewer.pagesRotation,
      scrollMode: nameOf(SCROLL_MODES, viewer.scrollMode) ?? "vertical",
      spreadMode: nameOf(SPREAD_MODES, viewer.spreadMode) ?? "none",
      canGoBack: this.#history.canGoBack,
      canGoForward: this.#history.canGoForward,
    };
  }

  pageLabel(page: number): string | undefined {
    return this.#pageLabels?.[page - 1];
  }

  // --- Saving and form sync ---------------------------------------------------

  /**
   * Reports the first change (dirty state) through `onSetModified` and every
   * field change (multi-editor sync) by wrapping `setValue`, which is what the
   * annotation layer calls on user input.
   */
  #trackFormChanges(storage: AnnotationStorage): void {
    // Typed as `null` in pdfjs-dist, but it is a documented callback hook.
    (storage as { onSetModified: (() => void) | null }).onSetModified = () => this.events.onModified();
    const setValue = storage.setValue.bind(storage);
    storage.setValue = (key: string, value: object) => {
      setValue(key, value);
      if (this.#applyingRemoteChanges) {
        return;
      }
      if (this.#saving) {
        this.#changedWhileSaving = true;
      }
      const entry: unknown = storage.getRawValue(key);
      // Form values are plain objects. Annotation editors (v2) are class
      // instances and need their own serialization before they can be synced.
      if (isPlainObject(entry)) {
        this.#changedFieldIds.add(key);
        this.#queueFieldChange(key, { ...entry });
      }
    };
  }

  #queueFieldChange(id: string, value: unknown): void {
    const flush = this.#pendingChanges.size === 0;
    this.#pendingChanges.set(id, value);
    if (flush) {
      queueMicrotask(() => {
        const changes = [...this.#pendingChanges].map(([changedId, changedValue]) => ({ id: changedId, value: changedValue }));
        this.#pendingChanges.clear();
        if (changes.length > 0) {
          this.events.onFieldChanges(changes);
        }
      });
    }
  }

  async save(): Promise<Uint8Array> {
    const document = this.#requireDocument();
    this.#saving = true;
    this.#changedWhileSaving = false;
    try {
      // saveDocument() resets the storage's modified flag when it completes.
      return document.annotationStorage.size > 0 ? await document.saveDocument() : await document.getData();
    } finally {
      this.#saving = false;
      if (this.#changedWhileSaving) {
        this.events.onModified();
      }
    }
  }

  markSaved(): void {
    this.#document?.annotationStorage.resetModified();
    this.#changedFieldIds.clear();
  }

  get changedFieldIds(): ReadonlySet<string> {
    return this.#changedFieldIds;
  }

  applyFieldChanges(changes: FieldChange[]): void {
    const storage = this.#document?.annotationStorage;
    if (!storage) {
      return;
    }
    this.#applyingRemoteChanges = true;
    try {
      for (const { id, value } of changes) {
        if (isPlainObject(value)) {
          storage.setValue(id, { ...value });
          this.#changedFieldIds.add(id);
          this.#updateRenderedField(id, value.value);
        }
      }
    } finally {
      this.#applyingRemoteChanges = false;
    }
  }

  /**
   * Updates a field's DOM element if its page is rendered; pages rendered
   * later read the value from the annotation storage.
   */
  #updateRenderedField(id: string, value: unknown): void {
    for (const element of this.container.querySelectorAll(`[data-element-id="${CSS.escape(id)}"]`)) {
      if (element instanceof HTMLInputElement && (element.type === "checkbox" || element.type === "radio")) {
        element.checked = value === true;
      } else if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
        element.value = typeof value === "string" ? value : String(value ?? "");
      } else if (element instanceof HTMLSelectElement) {
        const selected = Array.isArray(value) ? value : [value];
        for (const option of element.options) {
          option.selected = selected.includes(option.value);
        }
      }
    }
  }

  // --- Navigation -------------------------------------------------------------

  goToPage(page: number): void {
    if (this.#document && page >= 1 && page <= this.pageCount) {
      this.#history.pushCurrentPosition();
      this.#viewer.currentPageNumber = page;
    }
  }

  goToPageLabel(label: string): boolean {
    const trimmed = label.trim();
    const byLabel = this.#pageLabels?.indexOf(trimmed) ?? -1;
    const page = byLabel >= 0 ? byLabel + 1 : Number.parseInt(trimmed, 10);
    if (!Number.isInteger(page) || page < 1 || page > this.pageCount) {
      return false;
    }
    this.goToPage(page);
    return true;
  }

  goToDestination(dest: unknown): void {
    void this.#linkService.goToDestination(dest as string | unknown[]);
  }

  async getDestinationPage(dest: unknown): Promise<number | undefined> {
    const document = this.#requireDocument();
    try {
      const explicit = typeof dest === "string" ? await document.getDestination(dest) : dest;
      if (!Array.isArray(explicit)) {
        return undefined;
      }
      const [target] = explicit as unknown[];
      if (typeof target === "number") {
        return target + 1;
      }
      if (target && typeof target === "object") {
        return (await document.getPageIndex(target as { num: number; gen: number })) + 1;
      }
    } catch {
      // Broken destination.
    }
    return undefined;
  }

  back(): void {
    this.#history.back();
  }

  forward(): void {
    this.#history.forward();
  }

  // --- View ---------------------------------------------------------------

  zoomIn(): void {
    this.#viewer.increaseScale();
  }

  zoomOut(): void {
    this.#viewer.decreaseScale();
  }

  setScale(value: string): void {
    this.#viewer.currentScaleValue = value;
  }

  rotate(delta: 90 | -90): void {
    this.#viewer.pagesRotation = normalizeRotation(this.#viewer.pagesRotation + delta);
  }

  setScrollMode(mode: ScrollModeName): void {
    this.#viewer.scrollMode = SCROLL_MODES[mode];
  }

  setSpreadMode(mode: SpreadModeName): void {
    this.#viewer.spreadMode = SPREAD_MODES[mode];
  }

  setFieldHighlight(on: boolean): void {
    this.container.classList.toggle("no-field-highlight", !on);
  }

  // --- Panels -------------------------------------------------------------------

  async renderThumbnail(pageNumber: number, width: number): Promise<HTMLCanvasElement> {
    const ratio = window.devicePixelRatio || 1;
    const canvas = await this.#renderPage(pageNumber, (unscaled) => (width / unscaled.width) * ratio);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${Math.ceil(canvas.height / ratio)}px`;
    return canvas;
  }

  renderPageImage(pageNumber: number): Promise<HTMLCanvasElement> {
    return this.#renderPage(pageNumber, (unscaled) =>
      Math.min(PAGE_IMAGE_SCALE, Math.sqrt(PAGE_IMAGE_MAX_PIXELS / (unscaled.width * unscaled.height))),
    );
  }

  /** Renders a page off screen, rotated like the view, with the current form values. */
  async #renderPage(pageNumber: number, scaleFor: (unscaled: { width: number; height: number }) => number): Promise<HTMLCanvasElement> {
    const page = await this.#requireDocument().getPage(pageNumber);
    const rotation = (page.rotate + this.#viewer.pagesRotation) % 360;
    const viewport = page.getViewport({ scale: scaleFor(page.getViewport({ scale: 1, rotation })), rotation });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    await page.render({ canvas, viewport, annotationMode: AnnotationMode.ENABLE_STORAGE }).promise;
    return canvas;
  }

  // --- Export -------------------------------------------------------------------

  async getText(): Promise<string> {
    const document = this.#requireDocument();
    const pages: string[] = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
      const page = await document.getPage(pageNumber);
      const text = joinTextItems((await page.getTextContent()).items as TextItem[]);
      const label = this.#pageLabels?.[pageNumber - 1];
      const lines = text.split("\n").map((line) => line.trimEnd()).join("\n").trim();
      const marker = label ? t("--- Page {0} ({1}) ---", label, pageNumber) : t("--- Page {0} ---", pageNumber);
      pages.push(`${marker}\n${lines ? `${lines}\n` : ""}`);
    }
    return pages.join("\n");
  }

  async extractPages(pages: number[]): Promise<Uint8Array> {
    const document = this.#requireDocument();
    // extractPages() carries new annotations (editors) but not form values:
    // with unsaved values, extract from the bytes a save would write.
    const source = document.annotationStorage.size > 0 ? await this.save() : null;
    const pageInfo = { document: source, password: this.#password, includePages: pages.map((page) => page - 1) };
    return document.extractPages([pageInfo]);
  }

  async getOutline(): Promise<OutlineNode[]> {
    type RawNode = { title: string; bold: boolean; italic: boolean; dest: unknown; url: string | null; items: RawNode[] };
    const convert = (nodes: RawNode[]): OutlineNode[] =>
      nodes.map((node) => ({
        title: node.title,
        bold: node.bold,
        italic: node.italic,
        dest: node.dest,
        url: node.url ?? undefined,
        items: convert(node.items),
      }));
    return convert(((await this.#requireDocument().getOutline()) ?? []) as RawNode[]);
  }

  async getAttachments(): Promise<AttachmentInfo[]> {
    const raw = (await this.#requireDocument().getAttachments()) as Record<
      string,
      { filename: string; rawFilename?: string; description?: string; content: Uint8Array }
    > | null;
    return Object.values(raw ?? {}).map((item) => ({
      filename: item.filename || item.rawFilename || "attachment",
      description: item.description || undefined,
      data: item.content,
    }));
  }

  async getLayers(): Promise<LayerInfo[]> {
    const config = await this.#requireDocument().getOptionalContentConfig({ intent: "display" });
    const layers: LayerInfo[] = [];
    const seen = new Set<string>();
    const add = (id: string, depth: number) => {
      const group = config.getGroup(id) as { name?: string } | null;
      if (group && !seen.has(id)) {
        seen.add(id);
        layers.push({ id, name: group.name || id, visible: config.isVisible(group), depth });
      }
    };
    const walk = (order: unknown[], depth: number) => {
      for (const entry of order) {
        if (typeof entry === "string") {
          add(entry, depth);
        } else if (entry && typeof entry === "object" && "order" in entry) {
          walk((entry as { order: unknown[] }).order, depth + 1);
        }
      }
    };
    const order = config.getOrder() as unknown[] | null;
    if (order) {
      walk(order, 0);
    }
    for (const [id] of config as unknown as Iterable<[string, unknown]>) {
      add(id, 0);
    }
    return layers;
  }

  async setLayerVisible(id: string, visible: boolean): Promise<void> {
    const config = await this.#viewer.optionalContentConfigPromise;
    if (config) {
      config.setVisibility(id, visible);
      this.#viewer.optionalContentConfigPromise = Promise.resolve(config);
    }
  }

  async getProperties(): Promise<DocumentProperties> {
    const document = this.#requireDocument();
    const [{ info, metadata }, permissions, markInfo, firstPage] = await Promise.all([
      document.getMetadata(),
      document.getPermissions(),
      document.getMarkInfo().catch(() => null),
      document.getPage(1),
    ]);
    const meta = info as Record<string, unknown>;
    const text = (key: string) => (typeof meta[key] === "string" ? (meta[key] as string) : "");
    const [, , widthPt, heightPt] = firstPage.view;
    const pageSize = `${Math.round(((widthPt ?? 0) * 25.4) / 72)} × ${Math.round(((heightPt ?? 0) * 25.4) / 72)} mm (${Math.round(widthPt ?? 0)} × ${Math.round(heightPt ?? 0)} pt)`;
    const formKind = await detectFormKind(document);
    const fields: [string, string][] = [
      [t("Title"), metadata?.get("dc:title") ?? text("Title")],
      [t("Author"), text("Author")],
      [t("Subject"), text("Subject")],
      [t("Keywords"), text("Keywords")],
      [t("Creator"), text("Creator")],
      [t("Producer"), text("Producer")],
      [t("Created"), describeDate(text("CreationDate"))],
      [t("Modified"), describeDate(text("ModDate"))],
      [t("File size"), describeSize(this.#byteLength)],
      [t("Pages"), String(document.numPages)],
      [t("Page size"), pageSize],
      [t("PDF version"), text("PDFFormatVersion")],
      [t("Fast web view"), meta.IsLinearized ? t("Yes") : t("No")],
      [t("Tagged (accessible)"), (markInfo as { Marked?: boolean } | null)?.Marked ? t("Yes") : t("No")],
      [t("Language"), text("Language")],
      [t("Form"), { none: t("None"), acroform: "AcroForm", xfa: t("XFA (not supported)"), hybrid: "AcroForm + XFA" }[formKind]],
      [t("Digital signatures"), meta.IsSignaturesPresent ? t("Yes") : t("No")],
      [t("Encryption"), text("EncryptFilterName") || t("None")],
      [t("Permissions"), describePermissions(permissions)],
    ];
    return { fields: fields.filter(([, value]) => value !== "") };
  }

  /**
   * PDF.js only exposes font names with `fontExtraProperties`, which costs
   * memory, so the fonts are read from a second, short-lived copy of the
   * document: the operator list of each page loads its fonts.
   */
  async getFonts(onProgress?: (page: number, pageCount: number) => void): Promise<FontInfo[]> {
    const data = await this.#requireDocument().getData();
    const task = getDocument({
      data,
      password: this.#password,
      cMapUrl: this.config.cMapUrl,
      standardFontDataUrl: this.config.standardFontDataUrl,
      wasmUrl: this.config.wasmUrl,
      iccUrl: this.config.iccUrl,
      useWorkerFetch: false,
      enableXfa: false,
      fontExtraProperties: true,
      disableFontFace: true,
    });
    try {
      const document = await task.promise;
      const fonts = new Map<string, FontInfo>();
      const seen = new Set<string>();
      for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
        onProgress?.(pageNumber, document.numPages);
        const page = await document.getPage(pageNumber);
        const { fnArray, argsArray } = await page.getOperatorList();
        for (let i = 0; i < fnArray.length; i++) {
          const id = fnArray[i] === OPS.setFont ? (argsArray[i] as unknown[] | null)?.[0] : undefined;
          if (typeof id === "string" && !seen.has(id)) {
            seen.add(id);
            const font = await fontObject(page, id);
            const info = font && describeFont(font);
            if (info) {
              fonts.set(`${info.name}|${info.type}|${info.embedded}`, info);
            }
          }
        }
        page.cleanup();
      }
      return [...fonts.values()].sort((a, b) => a.name.localeCompare(b.name));
    } finally {
      await task.destroy();
    }
  }

  // --- Find -----------------------------------------------------------------

  find(query: FindQuery): void {
    const previous = this.#findQuery;
    this.#findQuery = query;
    const optionsChanged =
      previous !== undefined &&
      previous.query === query.query &&
      (previous.caseSensitive !== query.caseSensitive ||
        previous.entireWord !== query.entireWord ||
        previous.matchDiacritics !== query.matchDiacritics);
    const type = optionsChanged
      ? "casesensitivitychange"
      : previous?.query === query.query && previous.highlightAll !== query.highlightAll
        ? "highlightallchange"
        : "";
    this.#dispatchFind(type, false);
  }

  findAgain(previous: boolean): void {
    if (this.#findQuery?.query) {
      this.#dispatchFind("again", previous);
    }
  }

  closeFind(): void {
    this.#findQuery = undefined;
    this.#eventBus.dispatch("findbarclose", { source: this });
  }

  #dispatchFind(type: string, findPrevious: boolean): void {
    const query = this.#findQuery;
    if (!query) {
      return;
    }
    this.#eventBus.dispatch("find", {
      source: this,
      type,
      query: query.query,
      caseSensitive: query.caseSensitive,
      entireWord: query.entireWord,
      matchDiacritics: query.matchDiacritics,
      highlightAll: query.highlightAll,
      findPrevious,
    });
  }

  /**
   * Selects a given match (from the results panel). PDF.js has no API for it:
   * go to the page, start a new search there (it selects the page's first
   * match), then step forward `matchIndex` times.
   */
  selectMatch(page: number, matchIndex: number): void {
    if (!this.#findQuery) {
      return;
    }
    this.#viewer.currentPageNumber = page;
    this.#dispatchFind("casesensitivitychange", false);
    let remaining = matchIndex;
    const step = () => {
      const { pageIdx } = this.#findController.selected as { pageIdx: number };
      if (remaining <= 0 || pageIdx !== page - 1) {
        this.#eventBus.off("updatefindcontrolstate", step);
        return;
      }
      remaining--;
      this.#dispatchFind("again", false);
    };
    if (matchIndex > 0) {
      this.#eventBus.on("updatefindcontrolstate", step);
      setTimeout(() => this.#eventBus.off("updatefindcontrolstate", step), 5_000);
    }
  }

  async getFindResults(contextChars: number): Promise<FindResults> {
    const controller = this.#findController as unknown as {
      pageMatches: (number[] | undefined)[];
      pageMatchesLength: (number[] | undefined)[];
    };
    const results: FindResults = { query: this.#findQuery?.query ?? "", pagesSearched: 0, total: 0, pages: [] };
    const pages = controller.pageMatches.map((offsets, pageIndex) => ({ offsets, pageIndex })).filter(({ offsets }) => offsets);
    results.pagesSearched = pages.length;
    for (const { offsets, pageIndex } of pages) {
      if (!offsets || offsets.length === 0) {
        continue;
      }
      const page = await this.#pageText(pageIndex + 1);
      const lengths = controller.pageMatchesLength[pageIndex] ?? [];
      results.total += offsets.length;
      results.pages.push({
        page: pageIndex + 1,
        pageLabel: this.#pageLabels?.[pageIndex],
        matches: offsets.map((offset, index) => {
          const end = offset + (lengths[index] ?? 0);
          return {
            index,
            // A line break right before the match belongs to neither slice: keep it as a space.
            before: snippet(page.slice(Math.max(0, offset - contextChars), offset) + (page.breaksBefore(offset) ? " " : ""), "start"),
            match: page.slice(offset, end).normalize("NFC"),
            after: snippet(page.slice(end, end + contextChars), "end"),
          };
        }),
      });
    }
    return results;
  }

  /**
   * The page text in the coordinates of PDF.js's match offsets: the text items
   * concatenated without end-of-line breaks (verified against PDFFindController
   * in pdfjs-dist 6.4). `slice` puts a space where a line ended, for display.
   */
  #pageText(pageNumber: number): Promise<PageText> {
    let text = this.#pageTexts.get(pageNumber);
    if (!text) {
      text = this.#requireDocument()
        .getPage(pageNumber)
        .then((page) => page.getTextContent({ disableNormalization: true }))
        .then(({ items }) => {
          let content = "";
          const lineEnds = new Set<number>();
          let previousY: number | undefined;
          for (const item of items as TextItem[]) {
            // A run on another baseline starts a new line even without hasEOL ("and" | "government").
            const y = item.transform?.[5];
            if (item.str && y !== undefined && previousY !== undefined && Math.abs(y - previousY) > (item.height || 10) * 0.5) {
              lineEnds.add(content.length);
            }
            content += item.str ?? "";
            if (item.str) {
              previousY = y;
            }
            if (item.hasEOL) {
              lineEnds.add(content.length);
            }
          }
          return {
            slice(start: number, end: number): string {
              let out = "";
              for (let i = start; i < Math.min(end, content.length); i++) {
                if (lineEnds.has(i) && i > start) {
                  out += " ";
                }
                out += content[i];
              }
              return out;
            },
            breaksBefore: (index: number) => lineEnds.has(index),
          };
        });
      this.#pageTexts.set(pageNumber, text);
    }
    return text;
  }

  #findState(): FindState {
    const controller = this.#findController as unknown as {
      state: unknown;
      _matchesCountTotal?: number;
      selected: { pageIdx: number; matchIdx: number };
      pageMatches: (number[] | undefined)[];
    };
    const { pageMatches, selected } = controller;
    let total = 0;
    let current = 0;
    pageMatches.forEach((offsets, pageIndex) => {
      const count = offsets?.length ?? 0;
      if (pageIndex < selected.pageIdx) {
        current += count;
      }
      total += count;
    });
    current = selected.matchIdx >= 0 && total > 0 ? current + selected.matchIdx + 1 : 0;
    const pending = pageMatches.filter(Boolean).length < this.pageCount;
    const status: FindState["status"] = !this.#findQuery
      ? "idle"
      : total > 0
        ? "found"
        : pending
          ? "pending"
          : "notFound";
    return { status, current: Math.min(current, total), total };
  }

  // --- Forms ----------------------------------------------------------------

  async getFormFields(): Promise<FormFieldInfo[]> {
    this.#formWidgets ??= this.#collectFormWidgets();
    return [...(await this.#formWidgets).values()].map(({ info, raw }) => ({ ...info, value: this.#fieldValue(info, raw) }));
  }

  async #collectFormWidgets(): Promise<Map<string, { info: Omit<FormFieldInfo, "value">; raw: WidgetAnnotation }>> {
    const document = this.#requireDocument();
    const widgets = new Map<string, { info: Omit<FormFieldInfo, "value">; raw: WidgetAnnotation }>();
    if ((await document.getFieldObjects()) === null) {
      return widgets;
    }
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
      const annotations = (await (await document.getPage(pageNumber)).getAnnotations()) as WidgetAnnotation[];
      for (const raw of annotations) {
        if (raw.subtype !== "Widget" || !raw.fieldName || raw.hidden) {
          continue;
        }
        widgets.set(raw.id, {
          info: {
            id: raw.id,
            name: raw.fieldName,
            type: widgetType(raw),
            page: pageNumber,
            required: !!raw.required,
            readOnly: !!raw.readOnly,
          },
          raw,
        });
      }
    }
    return widgets;
  }

  /** The current displayable value of a field (storage first, then the file). */
  #fieldValue(info: Omit<FormFieldInfo, "value">, raw: WidgetAnnotation): string {
    const stored = (this.#document?.annotationStorage.getRawValue(info.id) as { value?: unknown } | undefined)?.value;
    switch (info.type) {
      case "checkbox": {
        const checked = stored !== undefined ? stored === true : raw.fieldValue === raw.exportValue;
        return checked ? "☑" : "☐";
      }
      case "radio": {
        const checked = stored !== undefined ? stored === true : raw.fieldValue === raw.buttonValue;
        return checked ? `● ${raw.buttonValue ?? ""}` : "";
      }
      default: {
        const value = stored ?? raw.fieldValue ?? "";
        return Array.isArray(value) ? value.join(", ") : String(value);
      }
    }
  }

  async focusField(id: string): Promise<void> {
    this.#formWidgets ??= this.#collectFormWidgets();
    const widget = (await this.#formWidgets).get(id);
    if (!widget) {
      return;
    }
    const field = widget.info;
    const { rect } = widget.raw;
    this.#history.pushCurrentPosition();
    this.#viewer.scrollPageIntoView({
      pageNumber: field.page,
      destArray: [null, { name: "XYZ" }, rect[0] - 20, rect[3] + 40, null],
      allowNegativeOffset: true,
    });
    const deadline = Date.now() + 3_000;
    const tryFocus = () => {
      const element = this.container.querySelector<HTMLElement>(`[data-element-id="${CSS.escape(id)}"]`);
      if (element) {
        element.focus({ preventScroll: true });
      } else if (Date.now() < deadline) {
        setTimeout(tryFocus, 50);
      }
    };
    tryFocus();
  }

  async clearForm(): Promise<void> {
    const storage = this.#requireDocument().annotationStorage;
    this.#formWidgets ??= this.#collectFormWidgets();
    for (const { info: field, raw: annotation } of (await this.#formWidgets).values()) {
      if (field.readOnly || field.type === "button" || field.type === "signature") {
        continue;
      }
      const fallback = annotation.defaultFieldValue ?? "";
      const value =
        field.type === "checkbox"
          ? fallback === annotation.exportValue
          : field.type === "radio"
            ? fallback === annotation.buttonValue
            : fallback;
      storage.setValue(field.id, { value });
      this.#updateRenderedField(field.id, value);
    }
  }

  async getFormValues(): Promise<FormFieldValue[]> {
    const storage = this.#requireDocument().annotationStorage;
    const stored = (id: string): unknown => (storage.getRawValue(id) as { value?: unknown } | undefined)?.value;
    const isChecked = (widget: FieldObject) => {
      const value = stored(widget.id);
      return value !== undefined ? value === true : widget.value === widget.exportValues && !isOff(widget.exportValues ?? null);
    };
    const values: FormFieldValue[] = [];
    for (const [name, widgets] of await this.#getFieldObjects()) {
      const [first] = widgets;
      // Widgets of one field share its value; the storage has it for the edited ones.
      const current = () => widgets.map((widget) => stored(widget.id)).find((value) => value !== undefined) ?? first?.value;
      switch (first?.type) {
        case "text":
          values.push({ name, type: "text", value: String(current() ?? "") });
          break;
        case "checkbox": {
          // Several widgets with different export values behave like radio buttons.
          const exportValues = new Set(widgets.map((widget) => widget.exportValues));
          if (exportValues.size > 1) {
            values.push({ name, type: "radio", value: widgets.find(isChecked)?.exportValues ?? null });
          } else {
            values.push({ name, type: "checkbox", value: widgets.some(isChecked), onValue: first.exportValues });
          }
          break;
        }
        case "radiobutton":
          values.push({ name, type: "radio", value: widgets.find(isChecked)?.exportValues ?? null });
          break;
        case "combobox":
        case "listbox": {
          const value = current();
          values.push({
            name,
            type: "choice",
            value: Array.isArray(value) ? value.map(String) : value === undefined || value === null ? null : String(value),
          });
          break;
        }
      }
    }
    return values;
  }

  async setFormValues(values: ReadonlyMap<string, FormValue>): Promise<FormImportResult> {
    const fields = await this.#getFieldObjects();
    const storage = this.#requireDocument().annotationStorage;
    const result: FormImportResult = { applied: 0, unknown: [] };
    for (const [name, value] of values) {
      const widgets = fields.get(name)?.filter((widget) => widget.type !== "button" && widget.type !== "signature");
      if (!widgets?.length) {
        result.unknown.push(name);
        continue;
      }
      if (widgets.every((widget) => widget.editable === false)) {
        continue;
      }
      for (const widget of widgets) {
        const stored = widgetValue(widget, value);
        storage.setValue(widget.id, { value: stored });
        this.#updateRenderedField(widget.id, stored);
      }
      result.applied++;
    }
    return result;
  }

  // --- Test support -----------------------------------------------------------

  async setFieldValuesByName(values: Record<string, string | boolean>): Promise<{ viaDom: string[]; viaStorage: string[] }> {
    const fields = await this.#getFieldObjects();
    const storage = this.#requireDocument().annotationStorage;
    const result = { viaDom: [] as string[], viaStorage: [] as string[] };

    for (const [name, value] of Object.entries(values)) {
      const widgets = fields.get(name);
      if (!widgets?.length) {
        throw new Error(`No form field named "${name}".`);
      }
      // Radio buttons: pick the widget whose export value matches.
      const widget = widgets[0].type === "radiobutton" ? widgets.find((w) => w.exportValues === value) : widgets[0];
      if (!widget) {
        throw new Error(`Field "${name}" has no option "${String(value)}".`);
      }
      const element = this.container.querySelector<HTMLElement>(`[data-element-id="${CSS.escape(widget.id)}"]`);
      if (element) {
        // Simulate user input, so the real annotation layer code path runs.
        simulateInput(element, widget.type, value);
        result.viaDom.push(name);
      } else {
        const storedValue = widget.type === "radiobutton" ? true : value;
        storage.setValue(widget.id, { value: storedValue });
        result.viaStorage.push(name);
      }
    }
    return result;
  }

  async getFieldValuesByName(): Promise<{ values: Record<string, unknown>; renderedWidgets: number }> {
    const fields = await this.#getFieldObjects();
    const storage = this.#requireDocument().annotationStorage;
    const stored = (id: string): unknown => (storage.getRawValue(id) as { value?: unknown } | undefined)?.value;
    const values: Record<string, unknown> = {};

    for (const [name, widgets] of fields) {
      const [first] = widgets;
      if (!first) {
        continue;
      }
      switch (first.type) {
        case "checkbox":
          values[name] = (stored(first.id) as boolean | undefined) ?? first.value === first.exportValues;
          break;
        case "radiobutton": {
          const selected = widgets.find((w) => stored(w.id) === true);
          values[name] = selected ? selected.exportValues : first.value;
          break;
        }
        case "text":
        case "combobox":
        case "listbox":
          values[name] = stored(first.id) ?? first.value;
          break;
      }
    }
    const renderedWidgets = this.container.querySelectorAll(
      "input[data-element-id], textarea[data-element-id], select[data-element-id]",
    ).length;
    return { values, renderedWidgets };
  }

  /**
   * Widgets by fully qualified field name. Since pdfjs-dist 6 the API returns
   * a Map, and it also lists a field's parent (non-widget) object, with an
   * empty `type`, when field and widget are separate objects.
   */
  async #getFieldObjects(): Promise<Map<string, FieldObject[]>> {
    const fields = ((await this.#requireDocument().getFieldObjects()) ?? new Map()) as Map<string, FieldObject[]>;
    return new Map([...fields].map(([name, objects]) => [name, objects.filter((object) => object.type)]));
  }

  #requireDocument(): PDFDocumentProxy {
    if (!this.#document) {
      throw new Error(t("No document is loaded."));
    }
    return this.#document;
  }
}

async function detectFormKind(document: PDFDocumentProxy): Promise<FormKind> {
  const { info } = await document.getMetadata();
  const { IsAcroFormPresent: acroForm, IsXFAPresent: xfa } = info as { IsAcroFormPresent?: boolean; IsXFAPresent?: boolean };
  if (xfa) {
    return acroForm ? "hybrid" : "xfa";
  }
  return acroForm ? "acroform" : "none";
}

async function detectEditableFields(document: PDFDocumentProxy): Promise<boolean> {
  const fields = (await document.getFieldObjects()) as Map<string, FieldObject[]> | null;
  if (!fields) {
    return false;
  }
  const editableTypes = new Set(["text", "checkbox", "radiobutton", "combobox", "listbox"]);
  return [...fields.values()].some((widgets) => widgets.some((w) => editableTypes.has(w.type) && w.editable !== false && !w.hidden));
}

function widgetType(annotation: WidgetAnnotation): FormFieldInfo["type"] {
  switch (annotation.fieldType) {
    case "Tx":
      return "text";
    case "Ch":
      return "choice";
    case "Sig":
      return "signature";
    default:
      return annotation.checkBox ? "checkbox" : annotation.radioButton ? "radio" : "button";
  }
}

/** Page text in the coordinates of PDF.js's find offsets (see #pageText). */
interface PageText {
  /** The text between two offsets, with a space where a line ended. */
  slice(start: number, end: number): string;
  /** True when a line ends just before `index`. */
  breaksBefore(index: number): boolean;
}

/** A text run from `getTextContent()` (subset); `transform[4..5]` is its origin. */
interface TextItem {
  str?: string;
  hasEOL?: boolean;
  transform?: number[];
  width?: number;
  height?: number;
}

/**
 * Page text for reading: PDF.js marks only some line ends (`hasEOL`), and
 * runs in separate table cells or columns touch ("GRADEComposition"). A run
 * on another baseline starts a new line; a gap on the same line adds a space.
 */
function joinTextItems(items: TextItem[]): string {
  let text = "";
  let previous: { y: number; end: number; height: number } | undefined;
  for (const item of items) {
    const str = item.str ?? "";
    const [, , , , x = 0, y = 0] = item.transform ?? [];
    const height = item.height || 10;
    if (str && previous && !text.endsWith("\n")) {
      if (Math.abs(y - previous.y) > Math.max(height, previous.height) * 0.5) {
        text += "\n";
      } else if (x - previous.end > height * 0.2 && !/\s$/.test(text) && !/^\s/.test(str)) {
        text += " ";
      }
    }
    text += str;
    if (str) {
      previous = { y, end: x + (item.width ?? 0), height };
    }
    if (item.hasEOL) {
      text += "\n";
    }
  }
  return text;
}

/** The annotation storage value of one widget for an imported field value. */
function widgetValue(widget: FieldObject, value: FormValue): unknown {
  switch (widget.type) {
    case "checkbox":
    case "radiobutton":
      // Checked when the value names this widget's option (or is `true` for a lone checkbox).
      return value === true || (typeof value === "string" && !isOff(value) && value === widget.exportValues);
    case "combobox":
    case "listbox": {
      // Like the annotation layer: a string, or an array for several selected options.
      const selected = Array.isArray(value) ? value : value === null || value === false ? [] : [String(value)];
      return selected.length > 1 ? selected : (selected[0] ?? null);
    }
    default:
      return Array.isArray(value) ? value.join(", ") : value === null || value === false ? "" : String(value);
  }
}

/** A font loaded by a page's operator list (PDF.js resolves it asynchronously). */
function fontObject(page: PDFPageProxy, id: string): Promise<Record<string, unknown> | undefined> {
  const objects = page.commonObjs as unknown as { get(id: string, callback: (data: unknown) => void): void };
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), 5_000);
    objects.get(id, (data) => {
      clearTimeout(timer);
      // A font that failed to load resolves to its error message.
      resolve(data && typeof data === "object" ? (data as Record<string, unknown>) : undefined);
    });
  });
}

function describeFont(font: Record<string, unknown>): FontInfo | undefined {
  const fullName = typeof font.name === "string" ? font.name : "";
  const type = typeof font.type === "string" ? font.type : font.isType3Font ? "Type3" : "";
  if (!fullName && !type) {
    return undefined;
  }
  const subset = /^[A-Z]{6}\+/.test(fullName);
  return {
    name: (subset ? fullName.slice(7) : fullName) || t("(unnamed)"),
    type: typeof font.subtype === "string" && font.subtype !== type ? `${type} (${font.subtype})` : type,
    embedded: font.isType3Font === true || font.missingFile !== true,
    subset,
  };
}

function describePermissions(permissions: Set<number> | number[] | null): string {
  if (permissions === null) {
    return t("No restrictions");
  }
  // PDF.js PermissionFlag values (PDF 32000-1, Table 22).
  const names: [number, string][] = [
    [0x04, t("print")],
    [0x08, t("modify")],
    [0x10, t("copy")],
    [0x20, t("annotate")],
    [0x100, t("fill forms")],
    [0x200, t("copy for accessibility")],
    [0x400, t("assemble")],
    [0x800, t("print high quality")],
  ];
  const granted = new Set(permissions);
  const allowed = names.filter(([flag]) => granted.has(flag)).map(([, name]) => name);
  const denied = names.filter(([flag]) => !granted.has(flag)).map(([, name]) => name);
  return denied.length === 0 ? t("No restrictions") : t("Allowed: {0} · Restricted: {1}", allowed.join(", ") || t("none"), denied.join(", "));
}

function snippet(text: string, cut: "start" | "end"): string {
  // Private-use characters are decorative glyphs (dingbats) with no meaning as text.
  const clean = text.replace(/[-]/g, " ").replace(/\s+/g, " ").normalize("NFC");
  if (cut === "start") {
    const space = clean.indexOf(" ");
    return space > 0 && space < 12 ? clean.slice(space + 1) : clean;
  }
  const space = clean.lastIndexOf(" ");
  return space > clean.length - 12 && space > 0 ? clean.slice(0, space) : clean;
}

function normalizeRotation(rotation: number): number {
  return ((rotation % 360) + 360) % 360;
}

function nameOf<T extends string>(map: Record<T, number>, value: number): T | undefined {
  return (Object.keys(map) as T[]).find((key) => map[key] === value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> & { value?: unknown } {
  return typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}

function simulateInput(element: HTMLElement, type: string, value: string | boolean): void {
  if (element instanceof HTMLInputElement && (type === "checkbox" || type === "radiobutton")) {
    element.checked = type === "radiobutton" ? true : value === true;
    element.dispatchEvent(new Event("change", { bubbles: true }));
  } else if (element instanceof HTMLSelectElement) {
    element.value = String(value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  } else if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    element.value = String(value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  }
}
