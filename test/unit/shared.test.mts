// Pure helpers of 0.3: page ranges (Print Pages…), page links (Copy Link to
// This Page) and form data files (JSON; XFDF writing — reading XFDF needs
// DOMParser and is covered by the integration tests).

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { isUriTarget, pageLinkQuery, parsePageLinkQuery } from "../../src/shared/pageLinks.js";
import { formatPageRanges, parsePageRanges } from "../../src/shared/pageRanges.js";
import { type FormFieldValue, parseJson, toJson, toXfdf } from "../../webview/forms/formData.js";

describe("parsePageRanges", () => {
  test("pages, ranges and open ranges, sorted and de-duplicated", () => {
    assert.deepEqual(parsePageRanges("1-3, 7, 10-", 12), [1, 2, 3, 7, 10, 11, 12]);
    assert.deepEqual(parsePageRanges("-2; 5 5 4", 6), [1, 2, 4, 5]);
    assert.deepEqual(parsePageRanges("2–4", 5), [2, 3, 4], "en dash");
  });

  test("rejects empty, malformed and out-of-range input", () => {
    for (const text of ["", " , ", "-", "0", "4-2", "1-13", "a", "1..3", "13"]) {
      assert.equal(parsePageRanges(text, 12), undefined, JSON.stringify(text));
    }
  });

  test("formatPageRanges is the shortest form", () => {
    assert.equal(formatPageRanges([1, 2, 3, 7, 9, 10]), "1-3, 7, 9-10");
    assert.equal(formatPageRanges([4]), "4");
  });
});

describe("page links", () => {
  test("a path with &, = and # survives the round trip", () => {
    const target = String.raw`D:\Giochi & Ruolo\a=b #1.pdf`;
    // VS Code hands the handler the decoded query.
    const decoded = decodeURIComponent(pageLinkQuery(target, 12));
    assert.deepEqual(parsePageLinkQuery(decoded), { page: 12, target });
  });

  test("rejects other queries", () => {
    assert.equal(parsePageLinkQuery("file=x.pdf&page=2"), undefined);
    assert.equal(parsePageLinkQuery("page=0&file=x.pdf"), undefined);
  });

  test("URIs and paths", () => {
    assert.equal(isUriTarget("vscode-remote://wsl+Ubuntu/home/a.pdf"), true);
    assert.equal(isUriTarget(String.raw`C:\a.pdf`), false);
    assert.equal(isUriTarget("/home/a.pdf"), false);
    assert.equal(isUriTarget(String.raw`\\server\share\a.pdf`), false);
  });
});

describe("form data", () => {
  const fields: FormFieldValue[] = [
    { name: "Nome", type: "text", value: "Mario & <Rossi>" },
    { name: "Clan.Famiglia", type: "text", value: "Rossi" },
    { name: "Clan.Scuola", type: "choice", value: "Corso base" },
    { name: "Abilità", type: "choice", value: ["Cortesia", "Meditazione"] },
    { name: "Iscritto", type: "checkbox", value: true, onValue: "Sì" },
    { name: "Esterno", type: "checkbox", value: false, onValue: "Yes" },
    { name: "Turno", type: "radio", value: null },
  ];

  test("JSON round trip", () => {
    const values = parseJson(toJson(fields, "scheda.pdf"));
    assert.deepEqual(Object.fromEntries(values), Object.fromEntries(fields.map((field) => [field.name, field.value])));
  });

  test("JSON: plain objects are accepted, other values ignored", () => {
    const values = parseJson('{ "a": "x", "b": 3, "c": true, "d": { "x": 1 }, "e": [1] }');
    assert.deepEqual(Object.fromEntries(values), { a: "x", b: "3", c: true });
    assert.throws(() => parseJson("[1, 2]"), /does not contain form data/);
    assert.throws(() => parseJson("{"), /not valid JSON/);
  });

  test("XFDF: nested names, escaped text, checkbox export values, Off", () => {
    const xfdf = toXfdf(fields, "scheda & co.pdf");
    assert.match(xfdf, /<f href="scheda &amp; co.pdf"\/>/);
    assert.match(xfdf, /<field name="Nome">\s*<value>Mario &amp; &lt;Rossi&gt;<\/value>/);
    assert.match(xfdf, /<field name="Clan">\s*<field name="Famiglia">\s*<value>Rossi<\/value>\s*<\/field>\s*<field name="Scuola">/);
    assert.match(xfdf, /<field name="Abilità">\s*<value>Cortesia<\/value>\s*<value>Meditazione<\/value>/);
    assert.match(xfdf, /<field name="Iscritto">\s*<value>Sì<\/value>/);
    assert.match(xfdf, /<field name="Esterno">\s*<value>Off<\/value>/);
    assert.match(xfdf, /<field name="Turno">\s*<value>Off<\/value>/);
  });
});
