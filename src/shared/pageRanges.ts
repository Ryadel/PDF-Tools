/**
 * Page ranges as people type them in print dialogs: `1-3, 7, 10-` (an open
 * range runs to the last page, `-5` starts at the first). Commas, semicolons
 * and spaces separate the parts; en dashes work like hyphens.
 *
 * Returns the sorted, de-duplicated 1-based page numbers, or undefined when
 * the text is empty, malformed, or names a page outside 1–`pageCount`.
 */
export function parsePageRanges(text: string, pageCount: number): number[] | undefined {
  const parts = text
    .replace(/[–—]/g, "-")
    .split(/[,;\s]+/)
    .filter(Boolean);
  if (parts.length === 0) {
    return undefined;
  }
  const pages = new Set<number>();
  for (const part of parts) {
    const match = /^(\d*)-(\d*)$/.exec(part) ?? /^(\d+)$/.exec(part);
    if (!match) {
      return undefined;
    }
    const isRange = part.includes("-");
    if (isRange && !match[1] && !match[2]) {
      return undefined;
    }
    const start = match[1] ? Number(match[1]) : 1;
    const end = isRange ? (match[2] ? Number(match[2]) : pageCount) : start;
    if (start < 1 || end > pageCount || start > end) {
      return undefined;
    }
    for (let page = start; page <= end; page++) {
      pages.add(page);
    }
  }
  return [...pages].sort((a, b) => a - b);
}

/** The shortest range text for sorted page numbers: `[1, 2, 3, 7]` → `1-3, 7`. */
export function formatPageRanges(pages: readonly number[]): string {
  const parts: string[] = [];
  for (let i = 0; i < pages.length; i++) {
    const start = pages[i];
    while (i + 1 < pages.length && pages[i + 1] === pages[i] + 1) {
      i++;
    }
    parts.push(start === pages[i] ? String(start) : `${start}-${pages[i]}`);
  }
  return parts.join(", ");
}
