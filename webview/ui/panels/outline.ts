import type { AppContext } from "../../app/context";
import type { OutlineNode } from "../../engine/pdfEngine";
import { t } from "../../l10n";
import { h } from "../dom";
import { icon } from "../icons";
import type { Panel } from "../sidebar";

/** The document outline (bookmarks): tree, filter, find current item. */
export class OutlinePanel implements Panel {
  readonly id = "outline";
  readonly title = t("Outline");
  readonly action = "showOutline";
  readonly element = h("div", { class: "outline" });
  readonly headerActions: HTMLElement[];
  readonly #filter: HTMLInputElement;
  readonly #tree = h("ul", { class: "tree", attrs: { role: "tree", "aria-label": t("Outline") } });
  #loading: Promise<void> | undefined;

  constructor(private readonly app: AppContext) {
    const headerButton = (iconName: Parameters<typeof icon>[0], label: string, run: () => void) =>
      h("button", { class: "icon", title: label, attrs: { type: "button", "aria-label": label }, on: { click: run } }, icon(iconName));
    this.headerActions = [
      headerButton("codicon:target", t("Find Current Item"), () => void this.#revealCurrent()),
      headerButton("codicon:expand-all", t("Expand All"), () => this.#setAllExpanded(true)),
      headerButton("codicon:collapse-all", t("Collapse All"), () => this.#setAllExpanded(false)),
    ];
    this.#filter = h("input", {
      class: "panel-filter",
      attrs: { type: "search", placeholder: t("Filter outline"), "aria-label": t("Filter outline") },
      on: { input: () => this.#applyFilter() },
    });
    this.element.append(this.#filter, this.#tree);
  }

  reset(): void {
    this.#loading = undefined;
    this.#tree.replaceChildren();
  }

  show(): void {
    this.#loading ??= this.app.engine.getOutline().then((nodes) => {
      this.#tree.replaceChildren(...(nodes.length ? nodes.map((node) => this.#item(node, 0)) : [h("li", { class: "empty", text: t("This PDF has no outline.") })]));
    });
  }

  #item(node: OutlineNode, depth: number): HTMLElement {
    const hasChildren = node.items.length > 0;
    const children = hasChildren ? h("ul", { attrs: { role: "group" } }, ...node.items.map((child) => this.#item(child, depth + 1))) : null;
    const twisty = h(
      "span",
      {
        class: "twisty",
        on: {
          click: (event) => {
            event.stopPropagation();
            row.parentElement!.classList.toggle("collapsed");
          },
        },
      },
      hasChildren ? icon("codicon:chevron-down") : null,
    );
    const row = h(
      "div",
      {
        class: "tree-row",
        attrs: { tabindex: "0" },
        on: {
          click: () => this.#open(node),
          keydown: (event) => {
            if (event.key === "Enter") {
              this.#open(node);
            } else if (event.key === "ArrowLeft" && hasChildren) {
              row.parentElement!.classList.add("collapsed");
            } else if (event.key === "ArrowRight" && hasChildren) {
              row.parentElement!.classList.remove("collapsed");
            }
          },
        },
      },
      twisty,
      h("span", { class: `tree-label${node.bold ? " bold" : ""}${node.italic ? " italic" : ""}`, text: node.title }),
    );
    row.style.paddingLeft = `${depth * 12 + 4}px`;
    const item = h("li", { attrs: { role: "treeitem" } }, row, children);
    (item as HTMLElement & { outlineNode?: OutlineNode }).outlineNode = node;
    // Like VS Code's outline: deep levels start collapsed.
    if (hasChildren && depth >= 1) {
      item.classList.add("collapsed");
    }
    return item;
  }

  #open(node: OutlineNode): void {
    if (node.url) {
      this.app.post({ type: "openExternal", url: node.url });
    } else if (node.dest) {
      this.app.engine.goToDestination(node.dest);
    }
  }

  #setAllExpanded(expanded: boolean): void {
    for (const item of this.#tree.querySelectorAll("li")) {
      item.classList.toggle("collapsed", !expanded && !!item.querySelector("ul"));
    }
  }

  #applyFilter(): void {
    const text = this.#filter.value.trim().toLocaleLowerCase();
    const visit = (item: HTMLElement): boolean => {
      const label = item.querySelector(":scope > .tree-row .tree-label")?.textContent?.toLocaleLowerCase() ?? "";
      const childMatches = [...item.querySelectorAll<HTMLElement>(":scope > ul > li")].map(visit).some(Boolean);
      const visible = !text || label.includes(text) || childMatches;
      item.hidden = !visible;
      if (text && childMatches) {
        item.classList.remove("collapsed");
      }
      return visible;
    };
    for (const item of this.#tree.querySelectorAll<HTMLElement>(":scope > li")) {
      visit(item);
    }
  }

  /** Selects the last outline item that starts at or before the current page. */
  async #revealCurrent(): Promise<void> {
    await this.#loading;
    const page = this.app.engine.view.page;
    let best: { item: HTMLElement; page: number } | undefined;
    for (const item of this.#tree.querySelectorAll<HTMLElement>("li")) {
      const node = (item as HTMLElement & { outlineNode?: OutlineNode }).outlineNode;
      if (!node?.dest) {
        continue;
      }
      const target = await this.app.engine.getDestinationPage(node.dest);
      if (target !== undefined && target <= page && (!best || target >= best.page)) {
        best = { item, page: target };
      }
    }
    for (const row of this.#tree.querySelectorAll(".tree-row.selected")) {
      row.classList.remove("selected");
    }
    if (best) {
      for (let parent = best.item.parentElement?.closest("li"); parent; parent = parent.parentElement?.closest("li")) {
        parent.classList.remove("collapsed");
      }
      const row = best.item.querySelector(":scope > .tree-row") as HTMLElement;
      row.classList.add("selected");
      row.scrollIntoView({ block: "center" });
      row.focus();
    }
  }
}
