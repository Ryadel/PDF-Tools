// End-to-end tests inside VS Code: the real custom editor, webview, PDF.js
// worker, CSP and save pipeline. The webview is driven through the test-only
// commands of src/testing/testCommands.ts.

import * as assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument } from "pdf-lib";
import * as vscode from "vscode";
import { CLAN_OPTIONS, createFormFixture, FIELDS, SCHOOL_OPTIONS } from "../fixtures/createFormFixture";

const VIEW_TYPE = "pdfTools.editor";

interface PanelState {
  loaded: boolean;
  loadCount: number;
  pageCount: number;
  formKind?: string;
  lastError?: string;
}

interface FieldValues {
  values: Record<string, unknown>;
  renderedWidgets: number;
}

async function waitFor<T>(check: () => T | Promise<T>, what: string, timeoutMs = 20_000): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await check();
    if (result) {
      return result as NonNullable<T>;
    }
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for: ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function panels(uri: vscode.Uri): Promise<PanelState[]> {
  const documents = await vscode.commands.executeCommand<{ uri: string; panels: PanelState[] }[]>("pdfTools.test.getState");
  return documents.find((document) => document.uri === uri.toString())?.panels ?? [];
}

/** Waits until `count` panels are loaded; fails fast on a load error. */
async function waitForLoaded(uri: vscode.Uri, count = 1, minLoadCount = 1): Promise<PanelState[]> {
  return waitFor(async () => {
    const states = await panels(uri);
    const failed = states.find((state) => state.lastError);
    if (failed) {
      throw new Error(`Load error: ${failed.lastError}`);
    }
    const ready = states.length === count && states.every((state) => state.loaded && state.loadCount >= minLoadCount);
    return ready ? states : undefined;
  }, `${count} loaded editor(s) for ${uri.fsPath}`);
}

function setFields(uri: vscode.Uri, values: Record<string, string | boolean>, panel = 0) {
  return vscode.commands.executeCommand<{ viaDom: string[]; viaStorage: string[] }>(
    "pdfTools.test.setFieldValues",
    uri.toString(),
    values,
    panel,
  );
}

function getFields(uri: vscode.Uri, panel = 0) {
  return vscode.commands.executeCommand<FieldValues>("pdfTools.test.getFieldValues", uri.toString(), panel);
}

function getProblems(uri: vscode.Uri, panel = 0) {
  return vscode.commands.executeCommand<string[]>("pdfTools.test.getProblems", uri.toString(), panel);
}

function tabsOf(uri: vscode.Uri): vscode.Tab[] {
  return vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .filter((tab) => tab.input instanceof vscode.TabInputCustom && tab.input.uri.toString() === uri.toString());
}

const isDirty = (uri: vscode.Uri) => tabsOf(uri).some((tab) => tab.isDirty);

async function readForm(uri: vscode.Uri) {
  return (await PDFDocument.load(await readFile(uri.fsPath))).getForm();
}

suite("PDF Tools editor", () => {
  let folder: string;

  suiteSetup(async () => {
    folder = await mkdtemp(join(tmpdir(), "pdf-tools-test-"));
  });

  teardown(async () => {
    // Tests leave their editors saved or reverted, so closing never prompts.
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });

  async function fixture(name: string, initial?: { name?: string }): Promise<vscode.Uri> {
    const path = join(folder, name);
    await writeFile(path, await createFormFixture(initial));
    return vscode.Uri.file(path);
  }

  test("opens, fills through the form UI, saves, and becomes dirty again on the next edit", async () => {
    const uri = await fixture("fill.pdf");
    await vscode.commands.executeCommand("vscode.openWith", uri, VIEW_TYPE);
    const [state] = await waitForLoaded(uri);
    assert.equal(state.pageCount, 1);
    assert.equal(state.formKind, "acroform");
    assert.equal(isDirty(uri), false, "clean after opening");

    // Wait for the annotation layer, so values go through real DOM events.
    await waitFor(async () => (await getFields(uri)).renderedWidgets >= 8, "rendered form widgets");
    const result = await setFields(uri, {
      [FIELDS.name]: "Onestà",
      [FIELDS.accentedName]: "Curiosità",
      [FIELDS.notes]: "Ryōsuke Kūkai",
      [FIELDS.agree]: true,
      [FIELDS.clan]: CLAN_OPTIONS[2],
      [FIELDS.school]: SCHOOL_OPTIONS[2],
    });
    assert.deepEqual(result.viaStorage, [], "every field was set through the DOM");
    await waitFor(() => isDirty(uri), "dirty after editing");

    await vscode.commands.executeCommand("workbench.action.files.save");
    await waitFor(() => !isDirty(uri), "clean after saving");

    let form = await readForm(uri);
    assert.equal(form.getTextField(FIELDS.name).getText(), "Onestà");
    assert.equal(form.getTextField(FIELDS.accentedName).getText(), "Curiosità");
    assert.equal(form.getTextField(FIELDS.notes).getText(), "Ryōsuke Kūkai");
    assert.equal(form.getCheckBox(FIELDS.agree).isChecked(), true);
    assert.equal(form.getRadioGroup(FIELDS.clan).getSelected(), CLAN_OPTIONS[2]);
    assert.deepEqual(form.getDropdown(FIELDS.school).getSelected(), [SCHOOL_OPTIONS[2]]);

    await setFields(uri, { [FIELDS.name]: "Seconda modifica" });
    await waitFor(() => isDirty(uri), "dirty again after the next edit");
    await vscode.commands.executeCommand("workbench.action.files.save");
    await waitFor(() => !isDirty(uri), "clean after the second save");

    form = await readForm(uri);
    assert.equal(form.getTextField(FIELDS.name).getText(), "Seconda modifica");
    assert.equal(form.getTextField(FIELDS.accentedName).getText(), "Curiosità", "earlier values are kept");

    // No CSP violation (worker, standard fonts, WASM) and no uncaught error.
    assert.deepEqual(await getProblems(uri), []);
  });


  test("keeps two editors of the same file in sync, and revert resets both", async () => {
    const uri = await fixture("sync.pdf");
    await vscode.commands.executeCommand("vscode.openWith", uri, VIEW_TYPE, vscode.ViewColumn.One);
    await waitForLoaded(uri, 1);

    // An unsaved edit made before the second editor opens is replayed to it.
    await setFields(uri, { [FIELDS.name]: "Prima del secondo editor" }, 0);
    await waitFor(() => isDirty(uri), "dirty");
    await vscode.commands.executeCommand("vscode.openWith", uri, VIEW_TYPE, vscode.ViewColumn.Two);
    await waitForLoaded(uri, 2);
    await waitFor(
      async () => (await getFields(uri, 1)).values[FIELDS.name] === "Prima del secondo editor",
      "replayed value in the second editor",
    );

    // Later edits are relayed both ways.
    await setFields(uri, { [FIELDS.accentedName]: "Dal primo" }, 0);
    await waitFor(async () => (await getFields(uri, 1)).values[FIELDS.accentedName] === "Dal primo", "relay 1 → 2");
    await setFields(uri, { [FIELDS.clan]: CLAN_OPTIONS[0] }, 1);
    await waitFor(async () => (await getFields(uri, 0)).values[FIELDS.clan] === CLAN_OPTIONS[0], "relay 2 → 1");

    // Revert (on the active editor) reloads both from disk.
    await vscode.commands.executeCommand("workbench.action.files.revert");
    await waitFor(() => !isDirty(uri), "clean after revert");
    await waitForLoaded(uri, 2, 2);
    for (const panel of [0, 1]) {
      const { values } = await getFields(uri, panel);
      assert.equal(values[FIELDS.name] || "", "", `editor ${panel} reverted`);
    }
  });

  test("reloads a clean document when the file changes on disk", async () => {
    const uri = await fixture("external.pdf");
    await vscode.commands.executeCommand("vscode.openWith", uri, VIEW_TYPE);
    await waitForLoaded(uri);

    await writeFile(uri.fsPath, await createFormFixture({ name: "Scritto da fuori" }));
    await waitForLoaded(uri, 1, 2);
    const { values } = await getFields(uri);
    assert.equal(values[FIELDS.name], "Scritto da fuori");
    assert.equal(isDirty(uri), false);
  });
});
