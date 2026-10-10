import type { AppContext } from "../../app/context";
import type { FindQuery, FindResults } from "../../engine/pdfEngine";
import { t } from "../../l10n";
import { h } from "../dom";
import { icon, type IconName } from "../icons";
import type { Panel } from "../sidebar";

const CONTEXT_CHARS = 48;
/** Rendering more rows than this at once makes the panel sluggish. */
const MAX_RESULTS = 2_000;
const RENDER_DELAY_MS = 150;

type SearchOption = "caseSensitive" | "entireWord" | "matchDiacritics";

/**
 * Every match in the document with its context, grouped by page — like
 * Acrobat's advanced search. Shares its query with the find widget; the list
 * fills in while PDF.js searches the pages.
 */
export class SearchPanel implements Panel {
  readonly id = "search";
  readonly title = t("Search");
  readonly action = "showSearch";
  readonly element = h("div", { class: "search-panel" });
  readonly #input: HTMLInputElement;
  readonly #toggles = new Map<SearchOption, HTMLButtonElement>();
  readonly #summary = h("div", { class: "search-summary", attrs: { "aria-live": "polite" } });
  readonly #results = h("div", { class: "search-results", attrs: { role: "list" } });
  #renderTimer: ReturnType<typeof setTimeout> | undefined;
  #lastRender = "";

  constructor(private readonly app: AppContext) {
    this.#input = h("input", {
      class: "panel-filter",
      attrs: { type: "search", placeholder: t("Search in document"), "aria-label": t("Search in document"), autocomplete: "off", spellcheck: "false" },
      on: {
        input: () => app.setFind({ query: this.#input.value }),
        keydown: (event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            this.#openFirst();
          }
        },
      },
    });
    const toggle = (option: SearchOption, iconName: IconName, label: string) => {
      const button = h(
        "button",
        {
          class: "icon find-toggle",
          title: label,
          attrs: { type: "button", "aria-label": label },
          on: {
            click: () => {
              app.setFind({ [option]: !app.state.find[option] } as Partial<FindQuery>);
              this.#refreshToggles();
            },
          },
        },
        icon(iconName),
      );
      this.#toggles.set(option, button);
      return button;
    };
    this.element.append(
      h(
        "div",
        { class: "search-box" },
        this.#input,
        toggle("caseSensitive", "codicon:case-sensitive", t("Match Case")),
        toggle("entireWord", "codicon:whole-word", t("Match Whole Word")),
        toggle("matchDiacritics", "diacritics", t("Match Diacritics (à ≠ a)")),
      ),
      this.#summary,
      this.#results,
    );
  }

  reset(): void {
    this.#lastRender = "";
    this.#results.replaceChildren();
    this.#summary.textContent = "";
  }

  show(): void {
    this.#input.value = this.app.state.find.query;
    this.#refreshToggles();
    void this.#render();
    this.#input.focus();
    this.#input.select();
  }

  onFindChange(): void {
    clearTimeout(this.#renderTimer);
    this.#renderTimer = setTimeout(() => void this.#render(), RENDER_DELAY_MS);
  }

  #refreshToggles(): void {
    for (const [option, button] of this.#toggles) {
      button.setAttribute("aria-pressed", String(this.app.state.find[option]));
    }
    if (document.activeElement !== this.#input) {
      this.#input.value = this.app.state.find.query;
    }
  }

  async #render(): Promise<void> {
    const { engine, state } = this.app;
    if (!state.find.query) {
      this.#results.replaceChildren();
      this.#summary.textContent = t("Type to search the whole document. Results show the surrounding text; click one to go there.");
      this.#lastRender = "";
      return;
    }
    const results = await engine.getFindResults(CONTEXT_CHARS);
    const key = `${results.query}|${results.total}|${results.pagesSearched}`;
    if (key === this.#lastRender) {
      return;
    }
    this.#lastRender = key;
    const searching = results.pagesSearched < engine.pageCount;
    const resultCount = results.total === 1 ? t("1 result") : t("{0} results", results.total);
    const pageCount = results.pages.length === 1 ? t("1 page") : t("{0} pages", results.pages.length);
    this.#summary.textContent =
      (results.total === 0 ? (searching ? t("Searching…") : t("No results.")) : t("{0} on {1}", resultCount, pageCount)) +
      (searching ? ` ${t("({0} of {1} pages searched)", results.pagesSearched, engine.pageCount)}` : "");
    this.#results.replaceChildren(...this.#rows(results));
  }

  #rows(results: FindResults): HTMLElement[] {
    const rows: HTMLElement[] = [];
    let shown = 0;
    for (const page of results.pages) {
      if (shown >= MAX_RESULTS) {
        rows.push(h("div", { class: "search-more", text: t("Showing the first {0} results. Refine the search to see the others.", MAX_RESULTS) }));
        break;
      }
      const label = page.pageLabel && page.pageLabel !== String(page.page) ? t("Page {0} ({1})", page.pageLabel, page.page) : t("Page {0}", page.page);
      rows.push(
        h("div", { class: "search-page", attrs: { role: "presentation" } }, h("span", { text: label }), h("span", { class: "badge", text: String(page.matches.length) })),
      );
      for (const match of page.matches) {
        if (shown++ >= MAX_RESULTS) {
          break;
        }
        rows.push(
          h(
            "div",
            {
              class: "search-result",
              attrs: { role: "listitem", tabindex: "0" },
              on: {
                click: (event) => this.#select(event.currentTarget as HTMLElement, page.page, match.index),
                keydown: (event) => {
                  if (event.key === "Enter") {
                    this.#select(event.currentTarget as HTMLElement, page.page, match.index);
                  } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                    event.preventDefault();
                    const items = [...this.#results.querySelectorAll<HTMLElement>(".search-result")];
                    const index = items.indexOf(event.currentTarget as HTMLElement);
                    items[index + (event.key === "ArrowDown" ? 1 : -1)]?.focus();
                  }
                },
              },
            },
            match.before ? `…${match.before}` : "",
            h("mark", { text: match.match }),
            match.after ? `${match.after}…` : "",
          ),
        );
      }
    }
    return rows;
  }

  #select(row: HTMLElement, page: number, matchIndex: number): void {
    for (const selected of this.#results.querySelectorAll(".search-result.selected")) {
      selected.classList.remove("selected");
    }
    row.classList.add("selected");
    this.app.engine.selectMatch(page, matchIndex);
  }

  #openFirst(): void {
    const first = this.#results.querySelector<HTMLElement>(".search-result");
    first?.click();
    first?.focus();
  }
}
