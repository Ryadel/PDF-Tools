const FILTER_ID = "pdfToolsPageColors";
const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * "Match Theme Colors": draws pages with the editor's background and
 * foreground colors through an SVG filter on the rendered page (CSS in
 * styles.css, class `page-colors` on <body>).
 *
 * Per channel, black → foreground and white → background (a linear map). In
 * dark themes that map inverts brightness, which would also turn hues into
 * their complements, so the filter first rotates hues by 180° to keep red red.
 * The colors follow theme changes (VS Code rewrites the variables on <html>).
 */
export class PageColors {
  readonly #hueRotate: SVGFEColorMatrixElement;
  readonly #channels: SVGFEFuncRElement[];
  #enabled = false;

  constructor() {
    const element = <K extends keyof SVGElementTagNameMap>(name: K, attributes: Record<string, string>) => {
      const node = document.createElementNS(SVG_NS, name);
      for (const [key, value] of Object.entries(attributes)) {
        node.setAttribute(key, value);
      }
      return node;
    };
    this.#hueRotate = element("feColorMatrix", { type: "hueRotate", values: "0" });
    this.#channels = (["feFuncR", "feFuncG", "feFuncB"] as const).map((name) => element(name, { type: "linear" }) as SVGFEFuncRElement);
    const transfer = element("feComponentTransfer", {});
    transfer.append(...this.#channels);
    const filter = element("filter", { id: FILTER_ID, "color-interpolation-filters": "sRGB" });
    filter.append(this.#hueRotate, transfer);
    const svg = element("svg", { class: "svg-defs", "aria-hidden": "true" });
    svg.append(filter);
    document.body.append(svg);

    const observer = new MutationObserver(() => this.#update());
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["style", "class"] });
    observer.observe(document.body, { attributes: true, attributeFilter: ["class"] });
  }

  set enabled(on: boolean) {
    if (on === this.#enabled) {
      return;
    }
    this.#enabled = on;
    document.body.classList.toggle("page-colors", on);
    this.#update();
  }

  #update(): void {
    if (!this.#enabled) {
      return;
    }
    const style = getComputedStyle(document.documentElement);
    const color = (...names: string[]) => names.map((name) => parseColor(style.getPropertyValue(name))).find(Boolean);
    const background = color("--vscode-editor-background") ?? [1, 1, 1];
    const foreground = color("--vscode-editor-foreground", "--vscode-foreground") ?? [0, 0, 0];
    const dark = luminance(background) < luminance(foreground);
    this.#hueRotate.setAttribute("values", dark ? "180" : "0");
    this.#channels.forEach((channel, index) => {
      channel.setAttribute("slope", String(background[index] - foreground[index]));
      channel.setAttribute("intercept", String(foreground[index]));
    });
  }
}

const probe = document.createElement("canvas").getContext("2d");

/** Any CSS color as [r, g, b] in 0–1, using the canvas to normalize it. */
function parseColor(css: string): [number, number, number] | undefined {
  if (!probe || !css.trim()) {
    return undefined;
  }
  probe.fillStyle = "#000000";
  probe.fillStyle = css.trim();
  const normalized = String(probe.fillStyle);
  const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(normalized);
  const rgb = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/i.exec(normalized);
  const parts = hex ? hex.slice(1).map((part) => Number.parseInt(part, 16)) : rgb ? rgb.slice(1).map(Number) : undefined;
  return parts ? [parts[0] / 255, parts[1] / 255, parts[2] / 255] : undefined;
}

function luminance([r, g, b]: [number, number, number]): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
