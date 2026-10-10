import type { AppContext } from "../../app/context";
import type { FormFieldInfo } from "../../engine/pdfEngine";
import { t } from "../../l10n";
import { h } from "../dom";
import { icon } from "../icons";
import type { Panel } from "../sidebar";

const REFRESH_DELAY_MS = 200;

/** Form fields: filterable; grouped as changed, required-but-empty, then by page. */
export class FieldsPanel implements Panel {
  readonly id = "fields";
  readonly title = t("Form Fields");
  readonly action = "showFields";
  readonly element = h("div", { class: "fields-panel" });
  readonly #filter: HTMLInputElement;
  readonly #list = h("div", { class: "field-list", attrs: { role: "list" } });
  #timer: ReturnType<typeof setTimeout> | undefined;
  #shown = false;

  constructor(private readonly app: AppContext) {
    this.#filter = h("input", {
      class: "panel-filter",
      attrs: { type: "search", placeholder: t("Filter by name or value"), "aria-label": t("Filter fields") },
      on: { input: () => void this.#render() },
    });
    this.element.append(this.#filter, this.#list);
  }

  available(): boolean {
    return this.app.state.hasForm;
  }

  reset(): void {
    this.#shown = false;
    this.#list.replaceChildren();
  }

  show(): void {
    this.#shown = true;
    void this.#render();
  }

  onFieldsChange(): void {
    if (!this.#shown) {
      return;
    }
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => void this.#render(), REFRESH_DELAY_MS);
  }

  async #render(): Promise<void> {
    const { engine } = this.app;
    const fields = await engine.getFormFields();
    const filter = this.#filter.value.trim().toLocaleLowerCase();
    const matches = (field: FormFieldInfo) =>
      !filter || field.name.toLocaleLowerCase().includes(filter) || field.value.toLocaleLowerCase().includes(filter);
    const visible = fields.filter(matches);
    const changed = visible.filter((field) => engine.changedFieldIds.has(field.id));
    const requiredEmpty = visible.filter((field) => field.required && isEmpty(field));

    const groups: [string, FormFieldInfo[]][] = [];
    if (changed.length) {
      groups.push([t("Changed ({0})", changed.length), changed]);
    }
    if (requiredEmpty.length) {
      groups.push([t("Required, empty ({0})", requiredEmpty.length), requiredEmpty]);
    }
    const byPage = new Map<number, FormFieldInfo[]>();
    for (const field of visible) {
      byPage.set(field.page, [...(byPage.get(field.page) ?? []), field]);
    }
    for (const [page, pageFields] of byPage) {
      groups.push([t("Page {0} ({1})", engine.pageLabel?.(page) ?? page, pageFields.length), pageFields]);
    }

    const scroll = this.#list.parentElement?.scrollTop ?? 0;
    this.#list.replaceChildren(
      ...(groups.length === 0
        ? [h("div", { class: "empty", text: fields.length ? t("No fields match the filter.") : t("This PDF has no form fields.") })]
        : groups.flatMap(([title, items]) => [
            h("div", { class: "field-group", text: title }),
            ...items.map((field) => this.#row(field, engine.changedFieldIds.has(field.id))),
          ])),
    );
    if (this.#list.parentElement) {
      this.#list.parentElement.scrollTop = scroll;
    }
  }

  #row(field: FormFieldInfo, changed: boolean): HTMLElement {
    const marker = changed
      ? h("span", { class: "field-marker changed", title: t("Changed, not saved") })
      : field.required && isEmpty(field)
        ? h("span", { class: "field-marker required", title: t("Required") }, icon("codicon:warning"))
        : h("span", { class: "field-marker" });
    return h(
      "div",
      {
        class: `field-row${field.readOnly ? " read-only" : ""}`,
        title: `${field.name}${field.required ? ` ${t("(required)")}` : ""}${field.readOnly ? ` ${t("(read-only)")}` : ""}`,
        attrs: { role: "listitem", tabindex: "0" },
        on: {
          click: () => void this.app.engine.focusField(field.id),
          keydown: (event) => {
            if (event.key === "Enter") {
              void this.app.engine.focusField(field.id);
            }
          },
        },
      },
      marker,
      h("span", { class: "field-name", text: field.name }),
      h("span", { class: "field-value", text: field.value }),
    );
  }
}

export function isEmpty(field: FormFieldInfo): boolean {
  return field.value === "" || field.value === "☐";
}
