import { type Action, tooltip } from "../app/actions";
import { h } from "./dom";
import { icon } from "./icons";

/** A toolbar button bound to an action: icon, tooltip, pressed and disabled state. */
export class ActionButton {
  readonly element: HTMLButtonElement;

  constructor(
    private readonly action: Action,
    options: { label?: boolean | string } = {},
  ) {
    const label = options.label === true ? action.label : options.label || undefined;
    this.element = h(
      "button",
      {
        class: label ? "icon labelled" : "icon",
        title: tooltip(action),
        attrs: { type: "button", "aria-label": action.label },
        on: { click: () => action.run() },
      },
      action.icon ? icon(action.icon) : null,
      label ? h("span", { text: label }) : null,
    );
    this.refresh();
  }

  refresh(): void {
    const checked = this.action.checked?.();
    if (checked !== undefined) {
      this.element.setAttribute("aria-pressed", String(checked));
    }
    this.element.disabled = !(this.action.enabled?.() ?? true);
  }
}

export function separator(): HTMLElement {
  return h("div", { class: "separator", attrs: { role: "separator" } });
}

export function spacer(): HTMLElement {
  return h("div", { class: "spacer" });
}
