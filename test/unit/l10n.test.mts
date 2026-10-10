// Translations (it, fr, de) cover every string of the English sources with the
// same {n} placeholders: l10n/bundle.l10n.json (UI, from `npm run l10n`) and
// package.nls.json (manifest).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const LANGUAGES = ["it", "fr", "de"];
const read = (path: string) => JSON.parse(readFileSync(join(root, path), "utf8")) as Record<string, string>;
const placeholders = (text: string) => (text.match(/\{\d+\}/g) ?? []).sort().join();

for (const [source, translated] of [
  ["l10n/bundle.l10n.json", (language: string) => `l10n/bundle.l10n.${language}.json`],
  ["package.nls.json", (language: string) => `package.nls.${language}.json`],
] as const) {
  describe(source, () => {
    const english = read(source);
    for (const language of LANGUAGES) {
      test(language, () => {
        const bundle = read(translated(language));
        assert.deepEqual(Object.keys(bundle).sort(), Object.keys(english).sort(), "same keys");
        for (const [key, text] of Object.entries(bundle)) {
          assert.ok(text.trim(), `${key}: empty`);
          assert.equal(placeholders(text), placeholders(english[key]), `${key}: placeholders`);
        }
      });
    }
  });
}
