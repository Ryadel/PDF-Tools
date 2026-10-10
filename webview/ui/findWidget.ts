import type { AppContext } from "../app/context";
import type { FindQuery, FindState } from "../engine/pdfEngine";
import { t } from "../l10n";
import { h } from "./dom";
import { icon, type IconName } from "./icons";

type FindOption = "caseSensitive" | "entireWord" | "matchDiacritics" | "highlightAll";

/**
 * The find widget (Ctrl+F), styled like VS Code's. The query is shared with
 * the Search panel, which lists every result (like Acrobat's advanced search).
 */
export class FindWidget {
  readonly element: HTMLElement;
  readonly #input: HTMLInputElement;
  readonly #count: HTMLElement;
  readonly #toggles = new Map<FindOption, HTMLButtonElement>();

  constructor(private readonly app: AppContext) {
    this.#input = h("input", {
      class: "find-input",
      attrs: { type: "text", placeholder: t("Find"), "aria-label": t("Find"), autocomplete: "off", spellcheck: "false" },
      on: {
        input: () => app.setFind({ query: this.#input.value }),
        keydown: (event) => this.#onKeyDown(event),
      },
    });
    this.#count = h("span", { class: "find-count", attrs: { "aria-live": "polite" } });

    const toggle = (option: FindOption, iconName: IconName, label: string, shortcut: string) => {
      const button = h(
        "button",
        {
          class: "icon find-toggle",
          title: `${label} (${shortcut})`,
          attrs: { type: "button", "aria-label": label },
          on: { click: () => this.#toggle(option) },
        },
        icon(iconName),
      );
      this.#toggles.set(option, button);
      return button;
    };
    const command = (iconName: IconName, label: string, run: () => void) =>
      h("button", { class: "icon", title: label, attrs: { type: "button", "aria-label": label }, on: { click: run } }, icon(iconName));

    this.element = h(
      "div",
      { class: "find-widget", attrs: { role: "search", hidden: true } },
      this.#input,
      toggle("caseSensitive", "codicon:case-sensitive", t("Match Case"), "Alt+C"),
      toggle("entireWord", "codicon:whole-word", t("Match Whole Word"), "Alt+W"),
      toggle("matchDiacritics", "diacritics", t("Match Diacritics (à ≠ a)"), "Alt+D"),
      toggle("highlightAll", "codicon:symbol-color", t("Highlight All"), "Alt+H"),
      this.#count,
      command("codicon:arrow-up", t("Previous Match (Shift+Enter)"), () => app.engine.findAgain(true)),
      command("codicon:arrow-down", t("Next Match (Enter)"), () => app.engine.findAgain(false)),
      command("codicon:list-flat", t("Show All Results (Ctrl+Shift+F)"), () => app.actions.run("showSearch")),
      command("codicon:close", t("Close (Escape)"), () => this.close()),
    );
  }

  get isOpen(): boolean {
    return !this.element.hidden;
  }

  /** Opens and focuses the widget; uses the selected text as query, if any. */
  open(): void {
    const selection = window.getSelection()?.toString().trim();
    if (selection && !selection.includes("\n") && selection.length < 200) {
      this.#input.value = selection;
      this.app.setFind({ query: selection });
    } else if (this.app.state.find.query) {
      this.#input.value = this.app.state.find.query;
      this.app.setFind({});
    }
    this.element.hidden = false;
    this.#input.focus();
    this.#input.select();
    this.refresh();
  }

  close(): void {
    if (!this.isOpen) {
      return;
    }
    this.element.hidden = true;
    this.app.engine.closeFind();
    this.app.refresh();
  }

  #toggle(option: FindOption): void {
    this.app.setFind({ [option]: !this.app.state.find[option] } as Partial<FindQuery>);
    this.refresh();
  }

  #onKeyDown(event: KeyboardEvent): void {
    const altOptions: Record<string, FindOption> = { c: "caseSensitive", w: "entireWord", d: "matchDiacritics", h: "highlightAll" };
    if (event.key === "Enter") {
      this.app.engine.findAgain(event.shiftKey);
    } else if (event.key === "Escape") {
      this.close();
    } else if (event.altKey && altOptions[event.key.toLowerCase()]) {
      this.#toggle(altOptions[event.key.toLowerCase()]);
    } else {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
  }

  /** Keeps the input in sync when the query changes elsewhere (Search panel). */
  refresh(): void {
    const { find } = this.app.state;
    if (document.activeElement !== this.#input && this.#input.value !== find.query) {
      this.#input.value = find.query;
    }
    for (const [option, button] of this.#toggles) {
      button.setAttribute("aria-pressed", String(find[option]));
    }
  }

  showState(state: FindState): void {
    this.#count.textContent = !this.app.state.find.query
      ? ""
      : state.status === "pending" && state.total === 0
        ? t("Searching…")
        : state.total === 0
          ? t("No results")
          : t("{0} of {1}", state.current || "?", state.total);
    this.#count.classList.toggle("no-results", state.status === "notFound");
  }
}
