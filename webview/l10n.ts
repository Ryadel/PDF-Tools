import type { WebviewConfig } from "../src/shared/protocol";

/**
 * Translations of the webview's UI strings. The host passes VS Code's l10n
 * bundle for the display language (`vscode.l10n.bundle`, i.e.
 * l10n/bundle.l10n.<language>.json) in the page's config; the English strings
 * are the keys, as with `vscode.l10n.t`. The config is read when this module
 * loads, so strings in module-level constants are translated too.
 */
// No DOM in the unit tests (Node), which import pure modules that use t().
const config = JSON.parse((typeof document === "undefined" ? undefined : document.body?.dataset.config) ?? "{}") as Partial<WebviewConfig>;
const bundle: Record<string, string> = config.l10n ?? {};

/** VS Code's display language ("en", "it", "de"…), for dates and numbers. */
export const language: string = config.language ?? "en";

/** `t("Page {0} of {1}", 3, 10)`: the translation of `message`, with `{n}` replaced by the arguments. */
export function t(message: string, ...args: (string | number)[]): string {
  const text = bundle[message] ?? message;
  return args.length === 0 ? text : text.replace(/\{(\d+)\}/g, (placeholder, index: string) => (Number(index) < args.length ? String(args[Number(index)]) : placeholder));
}
