import { type Action, tooltip } from "../app/actions";
import { h } from "./dom";
import { icon } from "./icons";

export type MenuEntry =
  | { kind: "section"; label: string }
  | { kind: "action"; action: Action }
  /** A row of icon toggles (e.g. scroll modes). */
  | { kind: "chips"; label: string; actions: Action[] }
  | { kind: "rule" }
  /** Starts the next column (wide editors; narrow ones stack the columns). */
  | { kind: "column" };

/**
 * The "…" dropdown menu. Rebuilt on every open so checked/enabled states are
 * current. Keyboard: ↑/↓ move, Enter/Space activate, Escape closes. Opens
 * below its anchor, or above it when the anchor is low (Focus mode's toolbar).
 */
export class Menu {
  readonly #element = h("div", { class: "menu", attrs: { role: "menu", hidden: true } });
  #anchor: HTMLElement | undefined;

  constructor(
    private readonly host: HTMLElement,
    private readonly entries: () => MenuEntry[],
  ) {
    host.append(this.#element);
    this.#element.addEventListener("keydown", (event) => this.#onKeyDown(event));
    document.addEventListener("pointerdown", (event) => {
      if (!this.isOpen || !(event.target instanceof Node)) {
        return;
      }
      if (!this.#element.contains(event.target) && !this.#anchor?.contains(event.target)) {
        this.close();
      }
    });
    window.addEventListener("blur", () => this.close());
  }

  get isOpen(): boolean {
    return !this.#element.hidden;
  }

  toggle(anchor: HTMLElement): void {
    if (this.isOpen) {
      this.close();
    } else {
      this.open(anchor);
    }
  }

  open(anchor: HTMLElement): void {
    this.#anchor = anchor;
    this.#render();
    this.#element.hidden = false;
    anchor.setAttribute("aria-expanded", "true");
    // Align the menu's right edge with the anchor, inside the host.
    const hostRect = this.host.getBoundingClientRect();
    const anchorRect = anchor.getBoundingClientRect();
    const style = this.#element.style;
    style.right = `${Math.max(4, hostRect.right - anchorRect.right)}px`;
    style.maxHeight = "";
    const spaceBelow = hostRect.bottom - anchorRect.bottom;
    const spaceAbove = anchorRect.top - hostRect.top;
    if (spaceBelow < this.#element.offsetHeight + 8 && spaceAbove > spaceBelow) {
      style.top = "";
      style.bottom = `${hostRect.bottom - anchorRect.top + 4}px`;
      style.maxHeight = `${spaceAbove - 12}px`;
    } else {
      style.bottom = "";
      style.top = `${anchorRect.bottom - hostRect.top + 4}px`;
    }
    this.#items()[0]?.focus();
  }

  close(): void {
    if (!this.isOpen) {
      return;
    }
    this.#element.hidden = true;
    this.#anchor?.setAttribute("aria-expanded", "false");
    this.#anchor?.focus();
  }

  #render(): void {
    let column = h("div", { class: "menu-column" });
    this.#element.replaceChildren(column);
    for (const entry of this.entries()) {
      switch (entry.kind) {
        case "column":
          column = h("div", { class: "menu-column" });
          this.#element.append(column);
          break;
        case "section":
          column.append(h("div", { class: "menu-section", text: entry.label }));
          break;
        case "rule":
          column.append(h("div", { class: "menu-rule", attrs: { role: "separator" } }));
          break;
        case "action":
          column.append(this.#item(entry.action));
          break;
        case "chips":
          column.append(
            h("div", { class: "menu-label", text: entry.label }),
            h(
              "div",
              { class: "menu-chips", attrs: { role: "group", "aria-label": entry.label } },
              ...entry.actions.map((action) => this.#chip(action)),
            ),
          );
          break;
      }
    }
  }

  #item(action: Action): HTMLElement {
    const checked = action.checked?.();
    const enabled = action.enabled?.() ?? true;
    return h(
      "button",
      {
        class: "menu-item",
        attrs: {
          type: "button",
          role: checked === undefined ? "menuitem" : "menuitemcheckbox",
          "aria-checked": checked === undefined ? undefined : String(checked),
          disabled: !enabled,
        },
        on: {
          click: () => {
            this.close();
            action.run();
          },
        },
      },
      h("span", { class: "menu-icon" }, checked ? icon("codicon:check") : action.icon ? icon(action.icon) : null),
      h("span", { class: "menu-text", text: action.label }),
      action.shortcut ? h("span", { class: "menu-shortcut", text: action.shortcut }) : null,
    );
  }

  #chip(action: Action): HTMLElement {
    return h(
      "button",
      {
        class: "icon menu-chip",
        title: tooltip(action),
        attrs: { type: "button", role: "menuitemradio", "aria-checked": String(action.checked?.() ?? false), "aria-label": action.label },
        on: {
          click: () => {
            action.run();
            this.#render();
            this.#items().find((item) => item.getAttribute("aria-label") === action.label)?.focus();
          },
        },
      },
      action.icon ? icon(action.icon) : null,
    );
  }

  #items(): HTMLButtonElement[] {
    return [...this.#element.querySelectorAll<HTMLButtonElement>("button:not([disabled])")];
  }

  #onKeyDown(event: KeyboardEvent): void {
    const items = this.#items();
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    switch (event.key) {
      case "Escape":
        this.close();
        break;
      case "ArrowDown":
        items[(index + 1) % items.length]?.focus();
        break;
      case "ArrowUp":
        items[(index - 1 + items.length) % items.length]?.focus();
        break;
      case "Home":
        items[0]?.focus();
        break;
      case "End":
        items.at(-1)?.focus();
        break;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
  }
}
