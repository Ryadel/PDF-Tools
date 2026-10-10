import type { AppContext } from "../../app/context";
import { t } from "../../l10n";
import { h } from "../dom";
import type { Panel } from "../sidebar";

const THUMBNAIL_WIDTH = 120;

/** Page thumbnails, rendered lazily when they scroll into view. */
export class ThumbnailsPanel implements Panel {
  readonly id = "thumbnails";
  readonly title = t("Pages");
  readonly action = "showThumbnails";
  readonly element = h("div", { class: "thumbnails", attrs: { role: "listbox", "aria-label": t("Pages") } });
  #items: HTMLElement[] = [];
  #observer: IntersectionObserver | undefined;
  #rotation = 0;
  #current = 0;

  constructor(private readonly app: AppContext) {}

  reset(): void {
    this.#observer?.disconnect();
    this.#observer = undefined;
    this.#items = [];
    this.element.replaceChildren();
  }

  show(): void {
    if (this.#items.length === 0) {
      this.#build();
    }
    this.onViewChange();
    this.#items[this.#current - 1]?.scrollIntoView({ block: "nearest" });
  }

  onViewChange(): void {
    const { page, rotation } = this.app.engine.view;
    if (rotation !== this.#rotation && this.#items.length > 0) {
      this.#rotation = rotation;
      this.reset();
      this.#build();
    }
    if (page !== this.#current) {
      this.#items[this.#current - 1]?.classList.remove("current");
      this.#items[this.#current - 1]?.setAttribute("aria-selected", "false");
      this.#current = page;
      const item = this.#items[page - 1];
      item?.classList.add("current");
      item?.setAttribute("aria-selected", "true");
      if (this.element.isConnected) {
        item?.scrollIntoView({ block: "nearest" });
      }
    }
  }

  #build(): void {
    const { engine } = this.app;
    this.#rotation = engine.view.rotation;
    this.#current = 0;
    this.#observer = new IntersectionObserver((entries) => this.#onVisible(entries), { root: this.element.parentElement, rootMargin: "200px" });
    const landscape = this.#rotation % 180 !== 0;
    for (let page = 1; page <= engine.pageCount; page++) {
      const frame = h("div", { class: "thumbnail-frame" });
      frame.style.width = `${THUMBNAIL_WIDTH}px`;
      frame.style.aspectRatio = landscape ? "1.414" : "0.707";
      const label = engine.view.page === page ? engine.view.pageLabel : undefined;
      const item = h(
        "div",
        {
          class: "thumbnail",
          dataset: { page: String(page) },
          attrs: { role: "option", tabindex: "0", "aria-label": t("Page {0}", page) },
          on: {
            click: () => engine.goToPage(page),
            keydown: (event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                engine.goToPage(page);
              }
            },
          },
        },
        frame,
        h("span", { class: "thumbnail-label", text: label ?? String(page) }),
      );
      this.#items.push(item);
      this.element.append(item);
      this.#observer.observe(item);
    }
  }

  #onVisible(entries: IntersectionObserverEntry[]): void {
    for (const entry of entries) {
      if (!entry.isIntersecting) {
        continue;
      }
      const item = entry.target as HTMLElement;
      this.#observer?.unobserve(item);
      const page = Number(item.dataset.page);
      const rotation = this.#rotation;
      void this.app.engine
        .renderThumbnail(page, THUMBNAIL_WIDTH)
        .then((canvas) => {
          if (rotation === this.#rotation && item.isConnected) {
            const frame = item.querySelector(".thumbnail-frame") as HTMLElement;
            frame.style.aspectRatio = "";
            frame.replaceChildren(canvas);
          }
        })
        .catch(() => {
          // Rendering cancelled (document replaced): nothing to show.
        });
    }
  }
}
