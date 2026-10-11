import type {
  HostCommand,
  HostToWebview,
  InitialView,
  LoadReason,
  PersistedViewState,
  ScrollModeName,
  SpreadModeName,
  ViewerCommand,
  ViewerMode,
  ViewerRequest,
  ViewerSettings,
  WebviewToHost,
} from "../../src/shared/protocol";
import { collectedProblems } from "../diagnostics";
import type { FindQuery, FindState, PdfEngine } from "../engine/pdfEngine";
import { parseFormData, serializeFormData } from "../forms/formData";
import { AutoHide } from "../ui/autoHide";
import { Banner } from "../ui/banner";
import { t } from "../l10n";
import { h, isEditableTarget } from "../ui/dom";
import { FindWidget } from "../ui/findWidget";
import { HandTool } from "../ui/handTool";
import { Menu, type MenuEntry } from "../ui/menu";
import { AttachmentsPanel, LayersPanel, PropertiesPanel } from "../ui/panels/documentPanels";
import { FieldsPanel, isEmpty } from "../ui/panels/fields";
import { PageColors } from "../ui/pageColors";
import { OutlinePanel } from "../ui/panels/outline";
import { SearchPanel } from "../ui/panels/search";
import { ThumbnailsPanel } from "../ui/panels/thumbnails";
import { Sidebar } from "../ui/sidebar";
import { Toolbar } from "../ui/toolbar";
import { type Action, ActionRegistry } from "./actions";
import type { AppContext, AppState } from "./context";

const STATUS_DELAY_MS = 100;
const VIEW_STATE_DELAY_MS = 600;
/** Presentation mode: one page change per wheel gesture. */
const PRESENTATION_WHEEL_MS = 350;

/** What presentation mode changes, restored when it ends. */
interface ViewBeforePresentation {
  scale: string;
  scrollMode: ScrollModeName;
  spreadMode: SpreadModeName;
  sidebarOpen: boolean;
}

export interface AppElements {
  row1: HTMLElement;
  row2: HTMLElement;
  strip: HTMLElement;
  sidebar: HTMLElement;
  canvasArea: HTMLElement;
  container: HTMLDivElement;
}

/** The webview application: state, actions, components and host messaging. */
export class App implements AppContext {
  readonly actions = new ActionRegistry();
  readonly state: AppState = {
    loaded: false,
    mode: "view",
    cursor: "select",
    sidebarOpen: false,
    panels: { view: "thumbnails", fill: "fields" },
    fieldHighlight: true,
    formKind: "none",
    hasForm: false,
    requiredEmpty: 0,
    find: { query: "", caseSensitive: false, entireWord: false, matchDiacritics: false, highlightAll: true },
    dirty: false,
    focus: false,
    pageColors: false,
    presenting: false,
    settings: { toolbar: "fixed", pageColors: "off" },
  };
  readonly banner = new Banner();
  readonly #toolbar: Toolbar;
  readonly #menu: Menu;
  readonly #sidebar: Sidebar;
  readonly #findWidget: FindWidget;
  readonly #handTool: HandTool;
  readonly #autoHide: AutoHide;
  readonly #pageColors = new PageColors();
  #beforePresentation: ViewBeforePresentation | undefined;
  #lastPresentationWheel = 0;
  #modeChosen = false;
  #statusTimer: ReturnType<typeof setTimeout> | undefined;
  #viewStateTimer: ReturnType<typeof setTimeout> | undefined;
  #requiredTimer: ReturnType<typeof setTimeout> | undefined;
  #passwordResolver: ((password: string | undefined) => void) | undefined;
  #lastFindState: FindState = { status: "idle", current: 0, total: 0 };
  /** Set once the engine exists (it needs the App's event callbacks). */
  engine!: PdfEngine;

  constructor(
    readonly post: (message: WebviewToHost) => void,
    private readonly elements: AppElements,
    createEngine: (app: App) => PdfEngine,
  ) {
    this.engine = createEngine(this);
    this.#registerActions();
    this.#menu = new Menu(elements.canvasArea, () => this.#menuEntries());
    this.#toolbar = new Toolbar(this, elements.row1, elements.row2, this.#menu);
    this.#findWidget = new FindWidget(this);
    elements.canvasArea.append(this.#findWidget.element);
    this.#sidebar = new Sidebar(this, elements.strip, elements.sidebar, [
      new ThumbnailsPanel(this),
      new OutlinePanel(this),
      new SearchPanel(this),
      new FieldsPanel(this),
      new AttachmentsPanel(this),
      new LayersPanel(this),
      new PropertiesPanel(this),
    ]);
    this.#handTool = new HandTool(elements.container);
    this.#autoHide = new AutoHide(elements.row1, () => this.#menu.isOpen);
    this.#listenToInput();
    this.refresh();
  }

  // --- Engine events (wired by main.ts) ------------------------------------------

  onModified(): void {
    this.post({ type: "modified" });
  }

  onFieldChanges(changes: { id: string; value: unknown }[]): void {
    this.post({ type: "fieldChanges", changes });
    this.onFieldsChanged();
  }

  onFieldsChanged(): void {
    this.#sidebar.visible?.onFieldsChange?.();
    this.#scheduleRequiredCount();
    this.#scheduleStatus();
  }

  onViewChange(): void {
    this.#toolbar.refresh();
    this.#sidebar.visible?.onViewChange?.();
    this.#scheduleStatus();
    this.#scheduleViewState();
  }

  onFindChange(state: FindState): void {
    this.#lastFindState = state;
    this.#findWidget.showState(state);
    this.#sidebar.visible?.onFindChange?.();
  }

  // --- AppContext -------------------------------------------------------------------

  refresh(): void {
    this.#toolbar.refresh();
    this.#sidebar.refresh();
    this.#findWidget.refresh();
    this.#handTool.selected = this.state.cursor === "hand" && !this.state.presenting;
    this.engine.setFieldHighlight(this.state.fieldHighlight);
    document.body.dataset.mode = this.state.mode;
    document.body.classList.toggle("focus-mode", this.state.focus && !this.state.presenting);
    document.body.classList.toggle("presenting", this.state.presenting);
    this.#autoHide.enabled = this.state.focus && !this.state.presenting;
    this.#pageColors.enabled = this.state.pageColors;
  }

  setFind(query: Partial<FindQuery>): void {
    Object.assign(this.state.find, query);
    if (this.state.find.query) {
      this.engine.find({ ...this.state.find });
    } else {
      this.engine.closeFind();
      this.onFindChange({ status: "idle", current: 0, total: 0 });
    }
    this.#findWidget.refresh();
  }

  // --- Host messages ---------------------------------------------------------------

  async handleMessage(message: HostToWebview): Promise<void> {
    switch (message.type) {
      case "load":
        await this.#load(message.data, message.reason, message.view);
        break;
      case "settings":
        this.#applySettings(message.settings);
        break;
      case "dirty":
        this.state.dirty = message.dirty;
        this.#toolbar.refresh();
        break;
      case "request":
        await this.#respond(message.requestId, () => this.#answer(message.request));
        break;
      case "requestSave":
        try {
          const data = await this.engine.save();
          this.post({ type: "saveResponse", requestId: message.requestId, data });
        } catch (error) {
          this.post({ type: "saveResponse", requestId: message.requestId, error: describe(error) });
        }
        break;
      case "saved":
        this.engine.markSaved(message.unsavedFieldIds);
        this.onFieldsChanged();
        break;
      case "applyFieldChanges":
        this.engine.applyFieldChanges(message.changes);
        this.onFieldsChanged();
        break;
      case "notice":
        this.banner.show(message.level, message.message);
        break;
      case "command":
        this.actions.run(message.command);
        break;
      case "goToPage":
        if (!this.engine.goToPageLabel(message.page)) {
          this.banner.show("warning", t("There is no page \"{0}\" in this document.", message.page));
        }
        break;
      case "setScale":
        this.engine.setScale(message.value);
        break;
      case "password":
        this.#passwordResolver?.(message.password);
        this.#passwordResolver = undefined;
        break;
      case "test.setFieldValues":
        await this.#respondToTest(message.requestId, () => this.engine.setFieldValuesByName(message.values));
        break;
      case "test.getFieldValues":
        await this.#respondToTest(message.requestId, () => this.engine.getFieldValuesByName());
        break;
      case "test.getProblems":
        await this.#respondToTest(message.requestId, async () => [...collectedProblems()]);
        break;
      case "test.getViewState":
        await this.#respondToTest(message.requestId, async () => ({
          view: this.engine.view,
          mode: this.state.mode,
          cursor: this.state.cursor,
          sidebarOpen: this.state.sidebarOpen,
          panel: this.state.panels[this.state.mode],
          hasForm: this.state.hasForm,
          requiredEmpty: this.state.requiredEmpty,
          dirty: this.state.dirty,
          focus: this.state.focus,
          pageColors: this.state.pageColors,
          presenting: this.state.presenting,
        }));
        break;
      case "test.find":
        await this.#respondToTest(message.requestId, () => this.#testFind(message.query, message.options ?? {}));
        break;
    }
  }

  #applySettings(settings: ViewerSettings): void {
    this.state.settings = settings;
    this.state.focus = settings.toolbar === "floating";
    this.state.pageColors = settings.pageColors === "theme";
    this.refresh();
  }

  /** Answers a host request (text, pages, page image, form data). */
  async #answer(request: ViewerRequest): Promise<unknown> {
    switch (request.kind) {
      case "text":
        return this.engine.getText();
      case "pages":
        return this.engine.extractPages(request.pages);
      case "pageImage":
        return new Uint8Array(await (await canvasToPng(await this.engine.renderPageImage(request.page))).arrayBuffer());
      case "exportForm":
        return serializeFormData(request.format, await this.engine.getFormValues(), request.fileName);
      case "importForm": {
        const result = await this.engine.setFormValues(parseFormData(request.format, request.text));
        this.onFieldsChanged();
        return result;
      }
    }
  }

  async #load(data: Uint8Array, reason: LoadReason, view: InitialView): Promise<void> {
    if (this.state.presenting) {
      this.#stopPresentation();
    }
    this.banner.hide();
    this.state.loaded = false;
    this.#sidebar.reset();
    this.engine.setInitialView(view);
    try {
      const result = await this.engine.load(data, { getPassword: (incorrect) => this.#askPassword(incorrect) });
      this.state.formKind = result.formKind;
      this.state.hasForm = result.formKind === "acroform" || result.formKind === "hybrid";
      if (reason === "open") {
        this.#applyInitialView(view, result.hasEditableFields);
      } else if (!this.state.hasForm) {
        this.state.mode = "view";
      }
      this.state.loaded = true;
      this.state.requiredEmpty = 0;
      this.refresh();
      this.#scheduleRequiredCount();
      this.#showFormNotice(reason);
      if (this.state.find.query && this.#findWidget.isOpen) {
        this.engine.find({ ...this.state.find });
      }
      this.post({ type: "loaded", pageCount: result.pageCount, formKind: result.formKind });
    } catch (error) {
      const message = loadErrorMessage(error);
      this.banner.show("error", message);
      this.post({ type: "loadError", message });
    }
  }

  #applyInitialView(view: InitialView, hasEditableFields: boolean): void {
    const remembered = view.mode !== "auto";
    this.#modeChosen = remembered;
    const mode: ViewerMode = remembered ? (view.mode as ViewerMode) : hasEditableFields ? "fill" : "view";
    this.state.mode = mode === "fill" && !this.state.hasForm ? "view" : mode;
    this.state.cursor = view.cursor;
    this.state.sidebarOpen = view.sidebar;
    if (view.panel) {
      this.state.panels[this.state.mode] = view.panel;
    }
  }

  #askPassword(incorrect: boolean): Promise<string | undefined> {
    this.post({ type: "passwordRequired", incorrect });
    return new Promise((resolve) => (this.#passwordResolver = resolve));
  }

  #showFormNotice(reason: LoadReason): void {
    if (this.state.formKind === "xfa") {
      this.banner.show(
        "warning",
        t("This PDF uses an XFA form, which PDF Tools does not support. The form cannot be filled here; open it in Adobe Acrobat or Reader."),
      );
    } else if (this.state.formKind === "hybrid") {
      this.banner.show(
        "info",
        t("This PDF contains both an XFA and a standard (AcroForm) form. PDF Tools fills the standard form; XFA-only features are ignored."),
      );
    } else if (reason === "external") {
      this.banner.show("info", t("The file changed on disk and has been reloaded."));
    }
  }

  // --- Status bar and remembered view ---------------------------------------------

  #scheduleStatus(): void {
    clearTimeout(this.#statusTimer);
    this.#statusTimer = setTimeout(() => {
      if (!this.state.loaded) {
        return;
      }
      const view = this.engine.view;
      const preset = ["auto", "page-actual", "page-fit", "page-width"].includes(view.scaleValue) ? view.scaleValue : undefined;
      this.post({
        type: "status",
        status: {
          page: view.page,
          pageLabel: view.pageLabel,
          pageCount: this.engine.pageCount,
          scale: view.scale,
          scalePreset: preset,
          mode: this.state.mode,
          hasForm: this.state.hasForm,
          changedFields: this.engine.changedFieldIds.size,
          requiredEmpty: this.state.requiredEmpty,
          canGoBack: view.canGoBack,
          canGoForward: view.canGoForward,
        },
      });
    }, STATUS_DELAY_MS);
  }

  #scheduleViewState(): void {
    clearTimeout(this.#viewStateTimer);
    this.#viewStateTimer = setTimeout(() => {
      // Presentation mode's view is temporary: remember the one before it.
      if (!this.state.loaded || this.state.presenting) {
        return;
      }
      const view = this.engine.view;
      const state: PersistedViewState = {
        page: view.page,
        scale: view.scaleValue,
        rotation: view.rotation,
        scrollMode: view.scrollMode,
        spreadMode: view.spreadMode,
        sidebar: this.state.sidebarOpen,
        panel: this.state.panels[this.state.mode],
        mode: this.#modeChosen ? this.state.mode : undefined,
      };
      this.post({ type: "viewState", state });
    }, VIEW_STATE_DELAY_MS);
  }

  #scheduleRequiredCount(): void {
    if (!this.state.hasForm) {
      return;
    }
    clearTimeout(this.#requiredTimer);
    this.#requiredTimer = setTimeout(() => {
      void this.engine.getFormFields().then((fields) => {
        const count = fields.filter((field) => field.required && !field.readOnly && isEmpty(field)).length;
        if (count !== this.state.requiredEmpty) {
          this.state.requiredEmpty = count;
          this.#toolbar.refresh();
          this.#scheduleStatus();
        }
      });
    }, 300);
  }

  // --- Actions ------------------------------------------------------------------------

  #registerActions(): void {
    const engine = () => this.engine;
    const view = () => this.engine.view;
    const loaded = () => this.state.loaded;
    const viewer = (id: ViewerCommand, label: string, run: () => void, extra: Partial<Action> = {}): Action => ({
      id,
      label,
      run,
      enabled: loaded,
      ...extra,
    });
    const scroll = (mode: ScrollModeName, label: string, icon: Action["icon"]) =>
      viewer(`scroll${capitalize(mode)}` as ViewerCommand, label, () => this.#do(() => engine().setScrollMode(mode)), {
        icon,
        checked: () => view().scrollMode === mode,
      });
    const spread = (mode: SpreadModeName, label: string, icon: Action["icon"]) =>
      viewer(`spread${capitalize(mode)}` as ViewerCommand, label, () => this.#do(() => engine().setSpreadMode(mode)), {
        icon,
        checked: () => view().spreadMode === mode,
      });
    const panel = (id: ViewerCommand, panelId: AppState["panels"]["view"], label: string, icon: Action["icon"]) =>
      viewer(id, label, () => this.#showPanel(panelId), {
        icon,
        checked: () => this.state.sidebarOpen && this.state.panels[this.state.mode] === panelId,
        enabled: () => true,
      });
    const host = (id: HostCommand, label: string, icon?: Action["icon"], shortcut?: string): Action => ({
      id,
      label,
      icon,
      shortcut,
      enabled: loaded,
      run: () => this.post({ type: "executeCommand", command: id }),
    });

    this.actions.register(
      // Navigation
      viewer("firstPage", t("First Page"), () => engine().goToPage(1), { icon: "first-page", shortcut: "Home" }),
      viewer("lastPage", t("Last Page"), () => engine().goToPage(engine().pageCount), { icon: "last-page", shortcut: "End" }),
      viewer("previousPage", t("Previous Page"), () => engine().goToPage(view().page - 1), {
        icon: "codicon:chevron-up",
        shortcut: "P",
        enabled: () => loaded() && view().page > 1,
      }),
      viewer("nextPage", t("Next Page"), () => engine().goToPage(view().page + 1), {
        icon: "codicon:chevron-down",
        shortcut: "N",
        enabled: () => loaded() && view().page < engine().pageCount,
      }),
      viewer("back", t("Back"), () => engine().back(), { icon: "codicon:arrow-left", shortcut: "Alt+←", enabled: () => loaded() && view().canGoBack }),
      viewer("forward", t("Forward"), () => engine().forward(), {
        icon: "codicon:arrow-right",
        shortcut: "Alt+→",
        enabled: () => loaded() && view().canGoForward,
      }),
      host("pdfTools.goToPage", t("Go to Page…"), "codicon:go-to-file", "Ctrl+G"),
      // Zoom
      viewer("zoomIn", t("Zoom In"), () => engine().zoomIn(), { icon: "codicon:zoom-in", shortcut: "Ctrl+=" }),
      viewer("zoomOut", t("Zoom Out"), () => engine().zoomOut(), { icon: "codicon:zoom-out", shortcut: "Ctrl+-" }),
      viewer("zoomActual", t("Actual Size"), () => engine().setScale("page-actual"), { shortcut: "Ctrl+0", checked: () => view().scaleValue === "page-actual" }),
      viewer("zoomAuto", t("Automatic Zoom"), () => engine().setScale("auto"), { checked: () => view().scaleValue === "auto" }),
      viewer("fitWidth", t("Fit to Width"), () => engine().setScale("page-width"), {
        icon: "codicon:arrow-both",
        checked: () => view().scaleValue === "page-width",
      }),
      viewer("fitPage", t("Fit Page"), () => engine().setScale("page-fit"), { icon: "fit-page", checked: () => view().scaleValue === "page-fit" }),
      // View
      viewer("rotateClockwise", t("Rotate Clockwise"), () => engine().rotate(90), { icon: "rotate-cw", shortcut: "R" }),
      viewer("rotateCounterclockwise", t("Rotate Counterclockwise"), () => engine().rotate(-90), { icon: "rotate-ccw", shortcut: "Shift+R" }),
      scroll("vertical", t("Vertical Scrolling"), "scroll-vertical"),
      scroll("horizontal", t("Horizontal Scrolling"), "scroll-horizontal"),
      scroll("wrapped", t("Wrapped Scrolling"), "scroll-wrapped"),
      scroll("page", t("Single Page"), "scroll-page"),
      spread("none", t("No Spreads"), "spread-none"),
      spread("odd", t("Odd Spreads"), "spread-odd"),
      spread("even", t("Even Spreads"), "spread-even"),
      viewer("selectTool", t("Text Selection Tool"), () => this.#setCursor("select"), {
        icon: "text-cursor",
        shortcut: "S",
        checked: () => this.state.cursor === "select",
      }),
      viewer("handTool", t("Hand Tool"), () => this.#setCursor("hand"), { icon: "hand", shortcut: "H", checked: () => this.state.cursor === "hand" }),
      // Modes
      viewer("viewMode", t("View"), () => this.#setMode("view"), { icon: "codicon:eye", shortcut: "1", checked: () => this.state.mode === "view" }),
      viewer("fillMode", t("Fill"), () => this.#setMode("fill"), {
        icon: "fields",
        shortcut: "2",
        checked: () => this.state.mode === "fill",
        enabled: () => loaded() && this.state.hasForm,
      }),
      // Find
      viewer("find", t("Find"), () => this.#findWidget.open(), { icon: "codicon:search", shortcut: "Ctrl+F" }),
      viewer("findNext", t("Find Next"), () => (this.state.find.query ? engine().findAgain(false) : this.#findWidget.open()), { shortcut: "F3" }),
      viewer("findPrevious", t("Find Previous"), () => (this.state.find.query ? engine().findAgain(true) : this.#findWidget.open()), {
        shortcut: "Shift+F3",
      }),
      // Sidebar
      viewer("toggleSidebar", t("Toggle Sidebar"), () => this.#toggleSidebar(), {
        icon: "codicon:layout-sidebar-left",
        shortcut: "F4",
        checked: () => this.state.sidebarOpen,
        enabled: () => true,
      }),
      panel("showThumbnails", "thumbnails", t("Pages"), "thumbnails"),
      panel("showOutline", "outline", t("Outline"), "codicon:list-tree"),
      { ...panel("showSearch", "search", t("Search Results"), "codicon:search"), shortcut: "Ctrl+Shift+F" },
      panel("showFields", "fields", t("Form Fields"), "fields"),
      panel("showAttachments", "attachments", t("Attachments"), "codicon:attach"),
      panel("showLayers", "layers", t("Layers"), "codicon:layers"),
      panel("showProperties", "properties", t("Document Properties"), "codicon:info"),
      // Forms
      viewer("toggleFieldHighlight", t("Highlight Fields"), () => this.#toggleFieldHighlight(), {
        icon: "codicon:eye",
        checked: () => this.state.fieldHighlight,
        enabled: () => loaded() && this.state.hasForm,
      }),
      viewer("nextField", t("Next Field"), () => void this.#moveField(1, false), {
        icon: "codicon:arrow-right",
        shortcut: "Tab",
        enabled: () => loaded() && this.state.hasForm,
      }),
      viewer("previousField", t("Previous Field"), () => void this.#moveField(-1, false), {
        icon: "codicon:arrow-left",
        shortcut: "Shift+Tab",
        enabled: () => loaded() && this.state.hasForm,
      }),
      viewer("nextRequiredField", t("Next Required Field"), () => void this.#moveField(1, true), {
        icon: "codicon:warning",
        enabled: () => loaded() && this.state.requiredEmpty > 0,
      }),
      viewer("clearForm", t("Clear Form"), () => void this.engine.clearForm().then(() => this.onFieldsChanged()), {
        enabled: () => loaded() && this.state.hasForm,
      }),
      { ...host("pdfTools.clearForm", t("Clear Form…"), "form-reset"), enabled: () => loaded() && this.state.hasForm },
      { ...host("pdfTools.exportFormData", t("Export Form Data…"), "codicon:export"), enabled: () => loaded() && this.state.hasForm },
      { ...host("pdfTools.importFormData", t("Import Form Data…")), enabled: () => loaded() && this.state.hasForm },
      // File
      { ...host("pdfTools.save", t("Save"), "codicon:save", "Ctrl+S"), enabled: () => loaded() && this.state.dirty },
      host("pdfTools.saveAs", t("Save As…"), undefined, "Ctrl+Shift+S"),
      host("pdfTools.print", t("Print"), "print"),
      host("pdfTools.printPages", t("Print Pages…")),
      // Page and document export
      host("pdfTools.copyPageLink", t("Copy Link to This Page"), "codicon:link"),
      viewer("copyPageImage", t("Copy Page as Image"), () => void this.#copyPageImage(), { icon: "codicon:copy" }),
      host("pdfTools.exportPageImage", t("Export Page as PNG…"), "codicon:file-media"),
      host("pdfTools.openText", t("Open Text in Editor"), "codicon:file-text"),
      // Reading
      viewer("togglePageColors", t("Match Theme Colors"), () => this.#toggle("pageColors"), {
        icon: "codicon:color-mode",
        checked: () => this.state.pageColors,
        enabled: () => true,
      }),
      viewer("toggleFocusMode", t("Focus Mode"), () => this.#toggle("focus"), {
        icon: "codicon:screen-full",
        checked: () => this.state.focus,
        enabled: () => true,
      }),
      viewer("presentationMode", t("Presentation Mode"), () => this.#togglePresentation(), {
        icon: "codicon:play",
        shortcut: "Ctrl+Alt+P",
        checked: () => this.state.presenting,
      }),
      { ...host("pdfTools.openSettings", t("PDF Tools Settings"), "codicon:settings-gear"), enabled: () => true },
    );
  }

  #menuEntries(): MenuEntry[] {
    const a = (id: Parameters<ActionRegistry["get"]>[0]) => this.actions.get(id);
    const action = (id: Parameters<ActionRegistry["get"]>[0]): MenuEntry => ({ kind: "action", action: a(id) });
    // Two columns: file, navigation and document on the left; view and form on the right.
    const entries: MenuEntry[] = [
      { kind: "section", label: t("File") },
      action("pdfTools.save"),
      action("pdfTools.saveAs"),
      action("pdfTools.print"),
      action("pdfTools.printPages"),
      { kind: "rule" },
      { kind: "section", label: t("Go to") },
      action("firstPage"),
      action("lastPage"),
      action("pdfTools.goToPage"),
      action("back"),
      action("forward"),
      { kind: "rule" },
      { kind: "section", label: t("Page") },
      action("pdfTools.copyPageLink"),
      action("copyPageImage"),
      action("pdfTools.exportPageImage"),
      { kind: "rule" },
      { kind: "section", label: t("Document") },
      action("find"),
      action("showSearch"),
      action("showOutline"),
      action("showAttachments"),
      action("showLayers"),
      action("showProperties"),
      action("pdfTools.openText"),
      { kind: "column" },
      { kind: "section", label: t("View") },
      action("zoomAuto"),
      action("zoomActual"),
      action("fitWidth"),
      action("fitPage"),
      action("rotateClockwise"),
      action("rotateCounterclockwise"),
      { kind: "chips", label: t("Scrolling"), actions: [a("scrollVertical"), a("scrollHorizontal"), a("scrollWrapped"), a("scrollPage")] },
      { kind: "chips", label: t("Spreads"), actions: [a("spreadNone"), a("spreadOdd"), a("spreadEven")] },
      { kind: "chips", label: t("Tool"), actions: [a("selectTool"), a("handTool")] },
      action("togglePageColors"),
      action("toggleFocusMode"),
      action("presentationMode"),
    ];
    if (this.state.hasForm) {
      entries.push(
        { kind: "rule" },
        { kind: "section", label: t("Form") },
        action("toggleFieldHighlight"),
        action("showFields"),
        action("pdfTools.clearForm"),
        action("pdfTools.exportFormData"),
        action("pdfTools.importFormData"),
      );
    }
    entries.push({ kind: "rule" }, action("pdfTools.openSettings"));
    return entries;
  }

  /** Runs a view change and remembers it for the file. */
  #do(change: () => void): void {
    change();
    this.onViewChange();
  }

  #setMode(mode: ViewerMode): void {
    this.state.mode = mode;
    this.#modeChosen = true;
    this.refresh();
    this.#scheduleStatus();
    this.#scheduleViewState();
  }

  #setCursor(cursor: AppState["cursor"]): void {
    this.state.cursor = cursor;
    this.refresh();
  }

  #toggleSidebar(): void {
    this.state.sidebarOpen = !this.state.sidebarOpen;
    this.refresh();
    this.#scheduleViewState();
  }

  #showPanel(panel: AppState["panels"]["view"]): void {
    const current = this.state.panels[this.state.mode];
    // Like VS Code's activity bar: clicking the open panel closes the sidebar.
    this.state.sidebarOpen = !(this.state.sidebarOpen && current === panel) || panel === "search";
    this.state.panels[this.state.mode] = panel;
    this.refresh();
    this.#scheduleViewState();
  }

  #toggleFieldHighlight(): void {
    this.state.fieldHighlight = !this.state.fieldHighlight;
    this.refresh();
  }

  /** Per-editor toggles of settings-driven state (until the setting changes). */
  #toggle(key: "focus" | "pageColors"): void {
    this.state[key] = !this.state[key];
    this.refresh();
  }

  // --- Presentation mode ------------------------------------------------------------

  #togglePresentation(): void {
    if (this.state.presenting) {
      this.#stopPresentation();
    } else {
      this.#startPresentation();
    }
  }

  /** One page at a time, fitted, without any UI; the host adds Zen mode (full screen). */
  #startPresentation(): void {
    const view = this.engine.view;
    this.#beforePresentation = {
      scale: view.scaleValue,
      scrollMode: view.scrollMode,
      spreadMode: view.spreadMode,
      sidebarOpen: this.state.sidebarOpen,
    };
    this.#menu.close();
    this.#findWidget.close();
    this.state.presenting = true;
    this.state.sidebarOpen = false;
    this.refresh();
    this.engine.setSpreadMode("none");
    this.engine.setScrollMode("page");
    this.engine.setScale("page-fit");
    this.elements.container.focus();
    this.post({ type: "presentation", active: true });
    // A hint over the page: a banner would resize the viewer and re-fit the page.
    const hint = h("div", { class: "presentation-hint", text: t("Arrow keys, Space or a click: next page · Escape: end the presentation") });
    this.elements.canvasArea.append(hint);
    setTimeout(() => hint.classList.add("fading"), 2_500);
    setTimeout(() => hint.remove(), 3_500);
  }

  #stopPresentation(): void {
    const before = this.#beforePresentation;
    this.#beforePresentation = undefined;
    this.state.presenting = false;
    if (before) {
      this.state.sidebarOpen = before.sidebarOpen;
      this.engine.setScrollMode(before.scrollMode);
      this.engine.setSpreadMode(before.spreadMode);
      this.engine.setScale(before.scale);
    }
    this.elements.canvasArea.querySelector(".presentation-hint")?.remove();
    this.refresh();
    this.post({ type: "presentation", active: false });
  }

  /** Keys while presenting; returns true when handled. */
  #presentationKey(event: KeyboardEvent): boolean {
    const steps: Record<string, number> = {
      ArrowRight: 1, ArrowDown: 1, PageDown: 1, " ": 1, Enter: 1, n: 1, j: 1,
      ArrowLeft: -1, ArrowUp: -1, PageUp: -1, Backspace: -1, p: -1, k: -1,
    };
    const page = this.engine.view.page;
    if (event.key === "Escape") {
      this.#stopPresentation();
    } else if (event.key === "Home") {
      this.engine.goToPage(1);
    } else if (event.key === "End") {
      this.engine.goToPage(this.engine.pageCount);
    } else if (steps[event.key] && !event.ctrlKey && !event.altKey && !event.metaKey) {
      this.engine.goToPage(page + (event.shiftKey && event.key === " " ? -1 : steps[event.key]));
    } else {
      return false;
    }
    return true;
  }

  // --- Page export -----------------------------------------------------------------

  async #copyPageImage(): Promise<void> {
    const page = this.engine.view.page;
    try {
      // From the Command Palette the webview gets focus back a moment later;
      // the clipboard only accepts writes from a focused document.
      if (!document.hasFocus()) {
        await new Promise((resolve) => {
          window.addEventListener("focus", resolve, { once: true });
          setTimeout(resolve, 1_000);
        });
      }
      // A promise of the image keeps the write within the user's gesture.
      const image = this.engine.renderPageImage(page).then(canvasToPng);
      await navigator.clipboard.write([new ClipboardItem({ "image/png": image })]);
      this.post({ type: "showMessage", level: "info", message: t("Copied page {0} as an image.", this.engine.pageLabel(page) ?? page) });
    } catch (error) {
      this.post({ type: "showMessage", level: "error", message: t("Could not copy page {0} as an image: {1}", page, describe(error)) });
    }
  }

  /** Focuses the next/previous field (or required empty field) after the focused one. */
  async #moveField(direction: 1 | -1, requiredOnly: boolean): Promise<void> {
    const fields = (await this.engine.getFormFields()).filter(
      (field) => !field.readOnly && field.type !== "button" && (!requiredOnly || (field.required && isEmpty(field))),
    );
    if (fields.length === 0) {
      return;
    }
    const focusedId = (document.activeElement as HTMLElement | null)?.dataset?.elementId;
    let index = fields.findIndex((field) => field.id === focusedId);
    if (index === -1) {
      const page = this.engine.view.page;
      index = direction === 1 ? fields.findIndex((field) => field.page >= page) - 1 : fields.findIndex((field) => field.page >= page);
    }
    const next = fields[(index + direction + fields.length) % fields.length];
    await this.engine.focusField(next.id);
  }

  // --- Keyboard and mouse --------------------------------------------------------------

  #listenToInput(): void {
    const keys: Record<string, ViewerCommand> = {
      n: "nextPage",
      j: "nextPage",
      p: "previousPage",
      k: "previousPage",
      r: "rotateClockwise",
      R: "rotateCounterclockwise",
      h: "handTool",
      s: "selectTool",
      "1": "viewMode",
      "2": "fillMode",
      Home: "firstPage",
      End: "lastPage",
      F4: "toggleSidebar",
    };
    window.addEventListener("keydown", (event) => {
      if (this.state.presenting && !isEditableTarget(event.target)) {
        if (this.#presentationKey(event)) {
          event.preventDefault();
        }
        return;
      }
      if (event.key === "Escape") {
        this.#findWidget.close();
        return;
      }
      if (event.ctrlKey || event.metaKey || event.altKey || isEditableTarget(event.target)) {
        return;
      }
      const command = keys[event.key];
      if (command) {
        event.preventDefault();
        this.actions.run(command);
      }
    });
    // Presentation: a click on the page (not on a link or a field) shows the next one.
    this.elements.container.addEventListener("click", (event) => {
      const target = event.target as Element | null;
      if (this.state.presenting && !target?.closest("a, input, textarea, select, button, .annotationLayer section")) {
        this.engine.goToPage(this.engine.view.page + 1);
      }
    });
    // Ctrl+wheel (and trackpad pinch, reported as Ctrl+wheel) zooms the document.
    this.elements.container.addEventListener(
      "wheel",
      (event) => {
        if (this.state.presenting && !event.ctrlKey) {
          event.preventDefault();
          const now = Date.now();
          if (now - this.#lastPresentationWheel > PRESENTATION_WHEEL_MS && event.deltaY !== 0) {
            this.#lastPresentationWheel = now;
            this.engine.goToPage(this.engine.view.page + Math.sign(event.deltaY));
          }
          return;
        }
        if (!event.ctrlKey) {
          return;
        }
        event.preventDefault();
        if (event.deltaY < 0) {
          this.engine.zoomIn();
        } else if (event.deltaY > 0) {
          this.engine.zoomOut();
        }
      },
      { passive: false },
    );
  }

  // --- Tests ----------------------------------------------------------------------------

  async #testFind(query: string, options: Partial<FindQuery>): Promise<unknown> {
    this.#findWidget.open();
    this.setFind({ caseSensitive: false, entireWord: false, matchDiacritics: false, ...options, query });
    // Let the new search start (PDF.js delays new queries by 250 ms) so stale results are not returned.
    await new Promise((resolve) => setTimeout(resolve, 600));
    const deadline = Date.now() + 20_000;
    for (;;) {
      const results = await this.engine.getFindResults(20);
      if ((results.pagesSearched >= this.engine.pageCount && this.#lastFindState.status !== "pending") || Date.now() > deadline) {
        return {
          total: results.total,
          pagesSearched: results.pagesSearched,
          pages: results.pages.map((page) => ({ page: page.page, count: page.matches.length, first: page.matches[0]?.match })),
          state: this.#lastFindState,
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  async #respond(requestId: number, run: () => Promise<unknown>): Promise<void> {
    try {
      this.post({ type: "response", requestId, result: await run() });
    } catch (error) {
      this.post({ type: "response", requestId, error: describe(error) });
    }
  }

  async #respondToTest(requestId: number, run: () => Promise<unknown>): Promise<void> {
    try {
      this.post({ type: "test.response", requestId, result: await run() });
    } catch (error) {
      this.post({ type: "test.response", requestId, error: describe(error) });
    }
  }
}

function loadErrorMessage(error: unknown): string {
  const name = error instanceof Error ? error.name : "";
  if (name === "PasswordCancelled") {
    return t("This PDF is password-protected. Reopen it and enter the password to view it.");
  }
  if (name === "InvalidPDFException") {
    return t("This file is not a valid PDF, or it is damaged.");
  }
  return t("Cannot display this PDF: {0}", describe(error));
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function canvasToPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error(t("The page could not be converted to PNG.")))), "image/png"),
  );
}

