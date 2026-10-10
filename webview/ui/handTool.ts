/**
 * Hand tool: drag to pan. Active when selected, or while Space is held
 * (temporary, like in Acrobat). Form fields and links keep working.
 */
export class HandTool {
  #selected = false;
  #spaceHeld = false;
  #drag: { x: number; y: number; left: number; top: number } | undefined;

  constructor(private readonly container: HTMLElement) {
    container.addEventListener("pointerdown", (event) => this.#onPointerDown(event));
    container.addEventListener("pointermove", (event) => this.#onPointerMove(event));
    container.addEventListener("pointerup", (event) => this.#endDrag(event));
    container.addEventListener("pointercancel", (event) => this.#endDrag(event));
  }

  set selected(on: boolean) {
    this.#selected = on;
    this.#update();
  }

  set spaceHeld(on: boolean) {
    this.#spaceHeld = on;
    this.#update();
  }

  get #active(): boolean {
    return this.#selected || this.#spaceHeld;
  }

  #update(): void {
    this.container.classList.toggle("hand-tool", this.#active);
  }

  #onPointerDown(event: PointerEvent): void {
    if (!this.#active || event.button !== 0) {
      return;
    }
    const target = event.target as HTMLElement;
    if (target.closest("input, textarea, select, button, a, .annotationLayer section")) {
      return;
    }
    this.#drag = { x: event.clientX, y: event.clientY, left: this.container.scrollLeft, top: this.container.scrollTop };
    this.container.setPointerCapture(event.pointerId);
    this.container.classList.add("grabbing");
    event.preventDefault();
    window.getSelection()?.removeAllRanges();
  }

  #onPointerMove(event: PointerEvent): void {
    if (!this.#drag) {
      return;
    }
    this.container.scrollLeft = this.#drag.left - (event.clientX - this.#drag.x);
    this.container.scrollTop = this.#drag.top - (event.clientY - this.#drag.y);
  }

  #endDrag(event: PointerEvent): void {
    if (this.#drag) {
      this.#drag = undefined;
      this.container.releasePointerCapture(event.pointerId);
      this.container.classList.remove("grabbing");
    }
  }
}
