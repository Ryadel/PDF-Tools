export type BannerLevel = "info" | "warning" | "error";

const ICONS: Record<BannerLevel, string> = {
  info: "codicon-info",
  warning: "codicon-warning",
  error: "codicon-error",
};

/** The dismissible message strip shown above the document. */
export class Banner {
  readonly #element = document.getElementById("banner") as HTMLDivElement;
  readonly #icon = this.#element.querySelector(".codicon") as HTMLSpanElement;
  readonly #text = document.getElementById("bannerText") as HTMLSpanElement;

  constructor() {
    document.getElementById("bannerClose")?.addEventListener("click", () => this.hide());
  }

  show(level: BannerLevel, message: string): void {
    this.#element.dataset.level = level;
    this.#icon.className = `codicon ${ICONS[level]}`;
    this.#text.textContent = message;
    this.#element.hidden = false;
  }

  hide(): void {
    this.#element.hidden = true;
  }
}
