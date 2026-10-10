/**
 * Links to a page of a PDF ("Copy Link to This Page"), handled by the
 * extension's URI handler: `vscode://Ryadel.pdf-tools/open?page=12&file=<target>`.
 *
 * `target` is a file system path for local files (readable when pasted) or a
 * full URI for other schemes. VS Code decodes the query once before handing it
 * to the handler, so `file` must come last and is taken verbatim: a path may
 * contain `&`, `=` or `#`.
 */

export const PAGE_LINK_PATH = "/open";

export function pageLinkQuery(target: string, page: number): string {
  return `page=${page}&file=${encodeURIComponent(target)}`;
}

/** The page and target of a decoded link query, or undefined if it is not one of ours. */
export function parsePageLinkQuery(query: string): { page: number; target: string } | undefined {
  const match = /^page=(\d+)&file=(.+)$/s.exec(query);
  if (!match) {
    return undefined;
  }
  const page = Number(match[1]);
  return page >= 1 ? { page, target: match[2] } : undefined;
}

/** True for `scheme://…` targets; false for paths (`D:\…`, `/home/…`, `\\server\…`). */
export function isUriTarget(target: string): boolean {
  return /^[a-z][a-z0-9+.-]+:\/\//i.test(target);
}
