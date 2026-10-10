import type { ActionId } from "../app/actions";
import type { AppContext } from "../app/context";
import { ActionButton, separator, spacer } from "./controls";
import { t } from "../l10n";
import { h } from "./dom";
import type { Menu } from "./menu";

const SCALE_OPTIONS: [value: string, label: string][] = [
  ["auto", t("Automatic")],
  ["page-actual", t("Actual Size")],
  ["page-fit", t("Page Fit")],
  ["page-width", t("Page Width")],
  ["0.5", "50%"],
  ["0.75", "75%"],
  ["1", "100%"],
  ["1.25", "125%"],
  ["1.5", "150%"],
  ["2", "200%"],
  ["3", "300%"],
  ["4", "400%"],
];

/**
 * Row 1 (always the same): sidebar, mode switch, page, zoom, find, save, print, "…".
 * Row 2: the tools of the current mode. In Focus mode row 1 floats over the
 * page (styles.css, `body.focus-mode`) and row 2 is hidden.
 */
export class Toolbar {
  readonly #buttons: ActionButton[] = [];
  readonly #modeSwitch: HTMLElement;
  readonly #pageInput: HTMLInputElement;
  readonly #pageCount: HTMLElement;
  readonly #scaleSelect: HTMLSelectElement;
  readonly #customScale: HTMLOptionElement;
  readonly #viewTools: HTMLElement;
  readonly #fillTools: HTMLElement;
  readonly #requiredButton: ActionButton;
  readonly #saveButton: HTMLElement;
  readonly #moreButton: HTMLButtonElement;

  constructor(
    private readonly app: AppContext,
    row1: HTMLElement,
    row2: HTMLElement,
    private readonly menu: Menu,
  ) {
    const button = (id: ActionId, options?: { label?: boolean | string }) => {
      const control = new ActionButton(app.actions.get(id), options);
      this.#buttons.push(control);
      return control.element;
    };

    // --- Row 1 ----------------------------------------------------------------
    this.#modeSwitch = h(
      "div",
      { class: "segmented", attrs: { role: "group", "aria-label": t("Mode") } },
      button("viewMode", { label: t("View") }),
      button("fillMode", { label: t("Fill") }),
    );

    this.#pageInput = h("input", {
      class: "page-input",
      title: t("Page (number or label)"),
      attrs: { type: "text", inputmode: "numeric", "aria-label": t("Page"), autocomplete: "off" },
      on: {
        change: () => this.#goToTypedPage(),
        keydown: (event) => {
          if (event.key === "Enter") {
            this.#goToTypedPage();
          }
        },
        focus: () => this.#pageInput.select(),
      },
    });
    this.#pageCount = h("span", { class: "label page-count" });

    this.#customScale = h("option", { attrs: { value: "custom", disabled: true, hidden: true } });
    this.#scaleSelect = h(
      "select",
      { class: "scale-select", title: t("Zoom"), attrs: { "aria-label": t("Zoom") }, on: { change: () => app.engine.setScale(this.#scaleSelect.value) } },
      ...SCALE_OPTIONS.map(([value, label]) => h("option", { text: label, attrs: { value } })),
      this.#customScale,
    );

    this.#moreButton = h(
      "button",
      {
        class: "icon more-actions",
        title: t("More Actions…"),
        attrs: { type: "button", "aria-label": t("More Actions"), "aria-haspopup": "menu", "aria-expanded": "false" },
        on: { click: () => menu.toggle(this.#moreButton) },
      },
      h("span", { class: "codicon codicon-ellipsis", attrs: { "aria-hidden": "true" } }),
    );

    this.#saveButton = button("pdfTools.save");
    row1.append(
      button("toggleSidebar"),
      separator(),
      this.#modeSwitch,
      h("div", { class: "group" }, button("previousPage"), button("nextPage"), this.#pageInput, this.#pageCount),
      separator(),
      h("div", { class: "group zoom" }, button("zoomOut"), this.#scaleSelect, button("zoomIn")),
      spacer(),
      button("find"),
      this.#saveButton,
      button("pdfTools.print"),
      this.#moreButton,
    );

    // --- Row 2 ----------------------------------------------------------------
    this.#viewTools = h(
      "div",
      { class: "tools", attrs: { role: "group", "aria-label": t("View tools") } },
      button("fitWidth"),
      button("fitPage"),
      separator(),
      button("rotateCounterclockwise"),
      button("rotateClockwise"),
      separator(),
      button("selectTool"),
      button("handTool"),
      separator(),
      button("scrollVertical"),
      button("scrollHorizontal"),
      button("scrollWrapped"),
      button("scrollPage"),
      separator(),
      button("spreadNone"),
      button("spreadOdd"),
      button("spreadEven"),
    );

    this.#requiredButton = new ActionButton(app.actions.get("nextRequiredField"), { label: true });
    this.#buttons.push(this.#requiredButton);
    this.#fillTools = h(
      "div",
      { class: "tools", attrs: { role: "group", "aria-label": t("Form tools") } },
      button("toggleFieldHighlight", { label: t("Highlight fields") }),
      separator(),
      button("previousField"),
      button("nextField"),
      this.#requiredButton.element,
      separator(),
      button("pdfTools.clearForm", { label: t("Clear form") }),
      h("span", { class: "hint", text: t("Tab moves between fields · Ctrl+S saves into the file") }),
    );
    row2.append(this.#viewTools, this.#fillTools);
  }

  #goToTypedPage(): void {
    if (!this.app.engine.goToPageLabel(this.#pageInput.value)) {
      this.refresh(); // Restore the current page.
    }
  }

  refresh(): void {
    const { engine, state } = this.app;
    for (const control of this.#buttons) {
      control.refresh();
    }
    const view = engine.view;
    const count = engine.pageCount;
    if (document.activeElement !== this.#pageInput) {
      this.#pageInput.value = view.pageLabel ?? String(view.page);
    }
    this.#pageCount.textContent = view.pageLabel ? t("({0} of {1})", view.page, count) : t("of {0}", count);

    const preset = SCALE_OPTIONS.find(([value]) => value === view.scaleValue || Number(value) === Number(view.scaleValue));
    if (preset) {
      this.#customScale.hidden = true;
      this.#scaleSelect.value = preset[0];
    } else {
      this.#customScale.textContent = `${Math.round(view.scale * 100)}%`;
      this.#customScale.hidden = false;
      this.#scaleSelect.value = "custom";
    }

    this.#modeSwitch.hidden = !state.hasForm;
    // Only forms can be changed (for now): elsewhere the button would always be disabled.
    this.#saveButton.hidden = !state.hasForm && !state.dirty;
    this.#viewTools.hidden = state.mode !== "view";
    this.#fillTools.hidden = state.mode !== "fill";
    const required = state.requiredEmpty;
    this.#requiredButton.element.hidden = required === 0;
    this.#requiredButton.element.querySelector("span:last-child")!.textContent = t("{0} required empty", required);
  }
}
