/**
 * Icons: Codicons where they exist, plus codicon-style SVGs (16×16, 1.1 px
 * stroke) for what Codicons lacks: neither Codicons nor VS Code's product icons
 * have print, rotate or hand icons.
 */

const SVG_ICONS = {
  print: '<path d="M4.5 5.5v-4h7v4"/><path d="M4.5 11.5h-2a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1h11a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1h-2"/><path d="M4.5 9.5h7v5h-7z"/><path d="M11.8 7.5h.4"/>',
  "rotate-cw": '<path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9"/><path d="M12.2 1.5v2.9H9.3"/>',
  "rotate-ccw": '<path d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9"/><path d="M3.8 1.5v2.9h2.9"/>',
  hand: '<path d="M5.5 8.5v-5a1 1 0 0 1 2 0v4M7.5 7V2.5a1 1 0 0 1 2 0V7M9.5 7V3.5a1 1 0 0 1 2 0V8M11.5 8V5.5a1 1 0 0 1 2 0v4.5a4.5 4.5 0 0 1-4.5 4.5h-.6a4 4 0 0 1-3.2-1.6L2.7 9.6a1 1 0 0 1 1.5-1.3l1.3 1.2"/>',
  "text-cursor": '<path d="M5.5 2.5c1.5 0 2.5.5 2.5 1.5v8c0 1-1 1.5-2.5 1.5M10.5 2.5C9 2.5 8 3 8 4v8c0 1 1 1.5 2.5 1.5M6.5 8h3"/>',
  thumbnails: '<rect x="2.5" y="1.5" width="4.5" height="5.5" rx=".5"/><rect x="9" y="1.5" width="4.5" height="5.5" rx=".5"/><rect x="2.5" y="9" width="4.5" height="5.5" rx=".5"/><rect x="9" y="9" width="4.5" height="5.5" rx=".5"/>',
  "first-page": '<path d="M3.5 3v10M12 3.5L7.5 8l4.5 4.5"/>',
  "last-page": '<path d="M12.5 3v10M4 3.5L8.5 8 4 12.5"/>',
  "scroll-vertical": '<rect x="4.5" y="1.5" width="7" height="5.5" rx=".5"/><rect x="4.5" y="9" width="7" height="5.5" rx=".5"/>',
  "scroll-horizontal": '<rect x="1.5" y="4.5" width="5.5" height="7" rx=".5"/><rect x="9" y="4.5" width="5.5" height="7" rx=".5"/>',
  "scroll-wrapped": '<rect x="1.5" y="1.5" width="5.5" height="5.5" rx=".5"/><rect x="9" y="1.5" width="5.5" height="5.5" rx=".5"/><rect x="1.5" y="9" width="5.5" height="5.5" rx=".5"/>',
  "scroll-page": '<rect x="3.5" y="1.5" width="9" height="13" rx=".5"/><path d="M6 5h4M6 7.5h4M6 10h2.5"/>',
  "spread-none": '<rect x="4.5" y="2.5" width="7" height="11" rx=".5"/>',
  "spread-odd": '<rect x="1.5" y="2.5" width="6" height="11" rx=".5"/><rect x="8.5" y="2.5" width="6" height="11" rx=".5"/><path d="M4.5 6v4"/>',
  "spread-even": '<rect x="1.5" y="2.5" width="6" height="11" rx=".5"/><rect x="8.5" y="2.5" width="6" height="11" rx=".5"/><path d="M10.5 6.5h2l-2 3h2"/>',
  "fit-page": '<rect x="4" y="1.5" width="8" height="13" rx=".5"/><path d="M6 5l2-1.5L10 5M6 11l2 1.5 2-1.5"/>',
  "form-reset": '<path d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9"/><path d="M3.8 1.5v2.9h2.9"/><path d="M6 8h4"/>',
  fields: '<rect x="1.5" y="3.5" width="13" height="4" rx=".5"/><rect x="1.5" y="9.5" width="8" height="4" rx=".5"/><path d="M3.5 5.5h1"/>',
  diacritics: '<path d="M4 13.5L7 4.5l3 9M5 10.5h4M7.5 1.5l1.5 1.5"/><path d="M11.5 9.5v4M11.5 7.5v.01"/>',
} as const;

export type SvgIconName = keyof typeof SVG_ICONS;
/** An own SVG icon, or `codicon:<name>` for a Codicon. */
export type IconName = SvgIconName | `codicon:${string}`;

const parser = document.createElement("template");

export function icon(name: IconName): Element {
  if (name.startsWith("codicon:")) {
    const span = document.createElement("span");
    span.className = `codicon codicon-${name.slice("codicon:".length)}`;
    span.setAttribute("aria-hidden", "true");
    return span;
  }
  parser.innerHTML = `<svg class="icon-svg" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">${SVG_ICONS[name as SvgIconName]}</svg>`;
  return parser.content.firstElementChild as Element;
}
