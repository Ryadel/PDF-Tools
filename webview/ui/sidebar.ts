import type { PanelId } from "../../src/shared/protocol";
import type { ActionId } from "../app/actions";
import type { AppContext } from "../app/context";
import { ActionButton } from "./controls";
import { h } from "./dom";

/** A sidebar panel. Panels load lazily the first time they are shown. */
export interface Panel {
  readonly id: PanelId;
  readonly title: string;
  readonly action: ActionId;
  /** The panel's content (scrolls inside the sidebar). */
  readonly element: HTMLElement;
  /** Buttons shown in the panel header. */
  readonly headerActions?: HTMLElement[];
  /** Hidden from the strip when false (e.g. Form Fields without a form). */
  available?(): boolean;
  show(): void;
  /** A new document was loaded. */
  reset(): void;
  onViewChange?(): void;
  onFindChange?(): void;
  onFieldsChange?(): void;
}

/** Activity strip (one icon per panel) + the active panel, like VS Code's own. */
export class Sidebar {
  readonly #stripButtons = new Map<PanelId, ActionButton>();
  readonly #title = h("h2", { class: "panel-title" });
  readonly #headerActions = h("div", { class: "panel-actions" });
  readonly #body = h("div", { class: "panel-body" });
  readonly #pane: HTMLElement;
  #visible: Panel | undefined;

  constructor(
    private readonly app: AppContext,
    strip: HTMLElement,
    pane: HTMLElement,
    private readonly panels: Panel[],
  ) {
    this.#pane = pane;
    pane.append(h("header", { class: "panel-header" }, this.#title, this.#headerActions), this.#body);
    for (const panel of panels) {
      const button = new ActionButton(app.actions.get(panel.action));
      button.element.classList.add("strip-button");
      this.#stripButtons.set(panel.id, button);
      strip.append(button.element);
      if (panel.id === "attachments") {
        strip.append(h("div", { class: "spacer" }));
      }
    }
  }

  panel(id: PanelId): Panel {
    return this.panels.find((panel) => panel.id === id)!;
  }

  reset(): void {
    this.#visible = undefined;
    for (const panel of this.panels) {
      panel.reset();
    }
  }

  refresh(): void {
    const { state } = this.app;
    const wanted = this.panel(state.panels[state.mode]);
    const target = wanted.available?.() === false ? this.panel("thumbnails") : wanted;
    for (const [id, button] of this.#stripButtons) {
      button.refresh();
      const panel = this.panel(id);
      button.element.hidden = panel.available?.() === false;
      button.element.classList.toggle("active", state.sidebarOpen && panel === target);
    }
    this.#pane.hidden = !state.sidebarOpen;
    if (!state.sidebarOpen || !state.loaded) {
      return;
    }
    if (this.#visible !== target) {
      this.#visible = target;
      this.#title.textContent = target.title;
      this.#headerActions.replaceChildren(...(target.headerActions ?? []));
      this.#body.replaceChildren(target.element);
      target.show();
    }
  }

  get visible(): Panel | undefined {
    return this.app.state.sidebarOpen ? this.#visible : undefined;
  }
}
