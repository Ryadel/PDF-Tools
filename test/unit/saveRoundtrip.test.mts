// Save round trip without UI: fill fields through PDF.js's annotation storage
// (what the webview does), save with saveDocument(), then read the result back
// with an independent library (pdf-lib).
//
// Node uses the "legacy" build, as PDF.js recommends for Node; the save logic
// runs in the worker code, which is the same as in the webview's build.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { after, describe, test } from "node:test";
import { PDFCheckBox, PDFDict, PDFDocument, PDFName, PDFTextField } from "pdf-lib";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { CLAN_OPTIONS, createFormFixture, FIELDS, SCHOOL_OPTIONS } from "../fixtures/createFormFixture.js";

type PdfjsDocument = Awaited<ReturnType<typeof getDocument>["promise"]>;
interface FieldObject {
  id: string;
  type: string;
  exportValues?: string;
}

const pdfjsRoot = dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"));
const standardFontDataUrl = join(pdfjsRoot, "standard_fonts") + "/";

// Accented (WinAnsi) and macron (outside WinAnsi) values.
const ACCENTED = "Onestà, Curiosità: àèìòù ÀÈÌÒÙ é";
const MACRONS = "Ryōsuke Kūkai ōū";

const loadingTasks: ReturnType<typeof getDocument>[] = [];
after(() => Promise.all(loadingTasks.map((task) => task.destroy())));

async function open(data: Uint8Array): Promise<PdfjsDocument> {
  // pdf.js takes ownership of the buffer: pass a copy.
  const task = getDocument({ data: data.slice(), standardFontDataUrl });
  loadingTasks.push(task);
  return task.promise;
}

/**
 * Widgets by field name. `getFieldObjects()` also lists a field's parent
 * (non-widget) object, with an empty `type`, when field and widget are separate
 * objects; values must be set on the widgets.
 */
async function fieldMap(document: PdfjsDocument): Promise<Map<string, FieldObject[]>> {
  const fields = ((await document.getFieldObjects()) ?? new Map()) as Map<string, FieldObject[]>;
  return new Map([...fields].map(([name, objects]) => [name, objects.filter((object) => object.type)]));
}

/** Sets values the way the annotation layer does on user input. */
async function fill(document: PdfjsDocument, values: Record<string, string | boolean>): Promise<void> {
  const fields = await fieldMap(document);
  for (const [name, value] of Object.entries(values)) {
    const widgets = fields.get(name);
    assert.ok(widgets?.length, `field ${name} exists`);
    if (widgets[0].type === "radiobutton") {
      for (const widget of widgets) {
        document.annotationStorage.setValue(widget.id, { value: widget.exportValues === value });
      }
    } else {
      document.annotationStorage.setValue(widgets[0].id, { value });
    }
  }
}

function startsWith(data: Uint8Array, prefix: Uint8Array): boolean {
  return data.length >= prefix.length && Buffer.from(data.subarray(0, prefix.length)).equals(Buffer.from(prefix));
}

function needAppearances(pdf: PDFDocument): boolean {
  const acroForm = pdf.catalog.lookup(PDFName.of("AcroForm"), PDFDict);
  return acroForm.get(PDFName.of("NeedAppearances"))?.toString() === "true";
}

function hasAppearance(field: PDFTextField | PDFCheckBox): boolean {
  return field.acroField.getWidgets().every((widget) => widget.getAppearances()?.normal !== undefined);
}

describe("save round trip (synthetic form)", () => {
  test("text, accented text, checkbox, radio and dropdown values survive saveDocument()", async () => {
    const original = await createFormFixture();
    const document = await open(original);
    await fill(document, {
      [FIELDS.name]: "Onestà",
      [FIELDS.accentedName]: "Curiosità",
      [FIELDS.notes]: `${ACCENTED}\nseconda riga`,
      [FIELDS.agree]: true,
      [FIELDS.clan]: CLAN_OPTIONS[1],
      [FIELDS.school]: SCHOOL_OPTIONS[1],
    });
    const saved = await document.saveDocument();

    assert.ok(startsWith(saved, original), "saved as an incremental update of the original bytes");

    const form = (await PDFDocument.load(saved)).getForm();
    assert.equal(form.getTextField(FIELDS.name).getText(), "Onestà");
    assert.equal(form.getTextField(FIELDS.accentedName).getText(), "Curiosità");
    assert.equal(form.getTextField(FIELDS.notes).getText(), `${ACCENTED}\nseconda riga`);
    assert.equal(form.getCheckBox(FIELDS.agree).isChecked(), true);
    assert.equal(form.getRadioGroup(FIELDS.clan).getSelected(), CLAN_OPTIONS[1]);
    assert.deepEqual(form.getDropdown(FIELDS.school).getSelected(), [SCHOOL_OPTIONS[1]]);

    // WinAnsi text gets a regular appearance stream.
    assert.ok(hasAppearance(form.getTextField(FIELDS.name)), "accented field has an appearance stream");
  });

  test("macrons (outside WinAnsi) are saved, with NeedAppearances instead of an appearance stream", async () => {
    const document = await open(await createFormFixture());
    await fill(document, { [FIELDS.name]: MACRONS });
    const saved = await document.saveDocument();

    const pdf = await PDFDocument.load(saved);
    const field = pdf.getForm().getTextField(FIELDS.name);
    assert.equal(field.getText(), MACRONS, "the value itself is stored correctly (UTF-16)");
    assert.equal(hasAppearance(field), false, "PDF.js writes no appearance for text the font cannot encode");
    assert.equal(needAppearances(pdf), true, "PDF.js asks viewers to regenerate appearances");

    // PDF.js itself reads the value back.
    const reread = await open(saved);
    const [widget] = (await fieldMap(reread)).get(FIELDS.name) ?? [];
    assert.equal((widget as { value?: unknown }).value, MACRONS);
  });

  test("the modified flag resets after saving and fires again on the next change", async () => {
    const document = await open(await createFormFixture());
    let modifiedEvents = 0;
    (document.annotationStorage as { onSetModified: (() => void) | null }).onSetModified = () => modifiedEvents++;

    await fill(document, { [FIELDS.name]: "Prima" });
    await fill(document, { [FIELDS.accentedName]: "Ancora" });
    assert.equal(modifiedEvents, 1, "one event for the first change only");

    await document.saveDocument();
    await fill(document, { [FIELDS.name]: "Seconda" });
    assert.equal(modifiedEvents, 2, "fires again after a save");

    // A second save still carries every value (the storage keeps them).
    const form = (await PDFDocument.load(await document.saveDocument())).getForm();
    assert.equal(form.getTextField(FIELDS.name).getText(), "Seconda");
    assert.equal(form.getTextField(FIELDS.accentedName).getText(), "Ancora");
  });
});
