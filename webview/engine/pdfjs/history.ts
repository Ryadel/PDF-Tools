import type { PDFViewer } from "pdfjs-dist/web/pdf_viewer.mjs";

interface Location {
  page: number;
  scale: number;
  top: number;
  left: number;
}

const MAX_ENTRIES = 50;

/**
 * Back/forward navigation for links, outline items, "go to page" and search
 * results. Implements the subset of PDF.js's `PDFHistory` interface that
 * `PDFLinkService` calls, without touching `window.history` (the webview's
 * iframe history belongs to VS Code).
 */
export class NavigationHistory {
  readonly #back: Location[] = [];
  readonly #forward: Location[] = [];

  constructor(
    private readonly viewer: PDFViewer,
    private readonly container: HTMLElement,
    private readonly onChange: () => void,
  ) {}

  get canGoBack(): boolean {
    return this.#back.length > 0;
  }

  get canGoForward(): boolean {
    return this.#forward.length > 0;
  }

  reset(): void {
    this.#back.length = 0;
    this.#forward.length = 0;
  }

  // Called by PDFLinkService before following a link.
  pushCurrentPosition(): void {
    const here = this.#current();
    const last = this.#back.at(-1);
    if (last && last.page === here.page && Math.abs(last.top - here.top) < 2) {
      return;
    }
    this.#back.push(here);
    if (this.#back.length > MAX_ENTRIES) {
      this.#back.shift();
    }
    this.#forward.length = 0;
    this.onChange();
  }

  push(): void {
    // The current position was saved by pushCurrentPosition().
  }

  pushPage(): void {
    // Same as push().
  }

  back(): void {
    const target = this.#back.pop();
    if (target) {
      this.#forward.push(this.#current());
      this.#restore(target);
    }
  }

  forward(): void {
    const target = this.#forward.pop();
    if (target) {
      this.#back.push(this.#current());
      this.#restore(target);
    }
  }

  #current(): Location {
    return {
      page: this.viewer.currentPageNumber,
      scale: this.viewer.currentScale,
      top: this.container.scrollTop,
      left: this.container.scrollLeft,
    };
  }

  #restore(location: Location): void {
    if (Math.abs(location.scale - this.viewer.currentScale) < 0.001) {
      this.container.scrollTo({ top: location.top, left: location.left });
    } else {
      this.viewer.currentPageNumber = location.page;
    }
    this.onChange();
  }
}
