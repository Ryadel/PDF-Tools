const HIDE_AFTER_MS = 2_000;

/**
 * Focus mode's floating toolbar: shown when the pointer moves, hidden after a
 * moment of inactivity unless the pointer is over it, it has keyboard focus,
 * or `keepVisible()` says so (an open menu).
 */
export class AutoHide {
  #enabled = false;
  #hovered = false;
  #timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly element: HTMLElement,
    private readonly keepVisible: () => boolean,
  ) {
    element.addEventListener("pointerenter", () => {
      this.#hovered = true;
      this.show();
    });
    element.addEventListener("pointerleave", () => {
      this.#hovered = false;
      this.show();
    });
    element.addEventListener("focusin", () => this.show());
    window.addEventListener("pointermove", () => this.show(), { passive: true });
  }

  set enabled(on: boolean) {
    if (on === this.#enabled) {
      return;
    }
    this.#enabled = on;
    clearTimeout(this.#timer);
    this.element.classList.remove("idle");
    if (on) {
      this.show();
    }
  }

  /** Shows the toolbar and restarts the hide timer. */
  show(): void {
    if (!this.#enabled) {
      return;
    }
    this.element.classList.remove("idle");
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => this.#hideIfIdle(), HIDE_AFTER_MS);
  }

  #hideIfIdle(): void {
    // Focus left by a mouse click does not count: only keyboard focus (and inputs) keeps it.
    const focused = document.activeElement;
    const keyboardFocus = focused instanceof HTMLElement && this.element.contains(focused) && focused.matches(":focus-visible");
    if (this.#hovered || keyboardFocus || this.keepVisible()) {
      this.show();
    } else {
      this.element.classList.add("idle");
    }
  }
}
