// v0.3 features end to end: Save button state and pdfTools.save, form data
// export/import (JSON, XFDF), page extraction for Print Pages, text and page
// image export, page links, presentation mode, live settings.

import * as assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument } from "pdf-lib";
import * as vscode from "vscode";
import { createDocumentFixture, DOCUMENT_PAGES } from "../fixtures/createDocumentFixture";
import { createFormFixture, FIELDS } from "../fixtures/createFormFixture";

const VIEW_TYPE = "pdfTools.editor";

interface ViewState {
  view: { page: number; scaleValue: string; scrollMode: string; spreadMode: string };
  sidebarOpen: boolean;
  dirty: boolean;
  focus: boolean;
  pageColors: boolean;
  presenting: boolean;
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

async function waitForLoaded(uri: vscode.Uri): Promise<void> {
  await waitFor(async () => {
    const documents = await vscode.commands.executeCommand<{ uri: string; panels: { loaded: boolean; lastError?: string }[] }[]>(
      "pdfTools.test.getState",
    );
    const panel = documents.find((document) => document.uri === uri.toString())?.panels[0];
    if (panel?.lastError) {
      throw new Error(`Load error: ${panel.lastError}`);
    }
    return panel?.loaded;
  }, `loaded ${uri.fsPath}`);
}

const viewState = (uri: vscode.Uri) => vscode.commands.executeCommand<ViewState>("pdfTools.test.getViewState", uri.toString());

function waitForView(uri: vscode.Uri, check: (state: ViewState) => boolean, what: string): Promise<ViewState> {
  return waitFor(async () => {
    const state = await viewState(uri);
    return check(state) ? state : undefined;
  }, what);
}

function request<T>(uri: vscode.Uri, viewerRequest: object): Promise<T> {
  return vscode.commands.executeCommand<T>("pdfTools.test.request", uri.toString(), viewerRequest) as Promise<T>;
}

function getFields(uri: vscode.Uri) {
  return vscode.commands.executeCommand<{ values: Record<string, unknown> }>("pdfTools.test.getFieldValues", uri.toString());
}

suite("PDF Tools 0.3", () => {
  let folder: string;

  suiteSetup(async () => {
    folder = await mkdtemp(join(tmpdir(), "pdf-tools-03-"));
  });

  teardown(async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });

  async function open(name: string, data: Uint8Array): Promise<vscode.Uri> {
    const uri = vscode.Uri.file(join(folder, name));
    await writeFile(uri.fsPath, data);
    await vscode.commands.executeCommand("vscode.openWith", uri, VIEW_TYPE);
    await waitForLoaded(uri);
    return uri;
  }

  test("the Save button follows the dirty state; pdfTools.save writes the file", async () => {
    const uri = await open("save.pdf", await createFormFixture());
    assert.equal((await viewState(uri)).dirty, false);

    await vscode.commands.executeCommand("pdfTools.test.setFieldValues", uri.toString(), { [FIELDS.name]: "Mario" });
    await waitForView(uri, (s) => s.dirty, "dirty after an edit");

    await vscode.commands.executeCommand("pdfTools.save");
    await waitForView(uri, (s) => !s.dirty, "clean after saving");
    const saved = await PDFDocument.load(await readFile(uri.fsPath));
    assert.equal(saved.getForm().getTextField(FIELDS.name).getText(), "Mario");
  });

  for (const format of ["json", "xfdf"] as const) {
    test(`form data ${format}: export from one form, import into another`, async () => {
      const source = await open(`export-${format}.pdf`, await createFormFixture());
      await vscode.commands.executeCommand("pdfTools.test.setFieldValues", source.toString(), {
        [FIELDS.name]: "Mario Rossi",
        [FIELDS.accentedName]: "Onestà",
        [FIELDS.agree]: true,
        [FIELDS.clan]: "Verde",
        [FIELDS.school]: "Sud",
      });
      const text = await request<string>(source, { kind: "exportForm", format, fileName: "export.pdf" });
      assert.match(text, format === "json" ? /"Mario Rossi"/ : /<value>Mario Rossi<\/value>/);
      await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");

      const target = await open(`import-${format}.pdf`, await createFormFixture());
      const result = await request<{ applied: number; unknown: string[] }>(target, { kind: "importForm", format, text });
      assert.deepEqual(result.unknown, []);
      assert.equal(result.applied, 6, "every field of the form, the empty notes included");
      const { values } = await getFields(target);
      assert.equal(values[FIELDS.name], "Mario Rossi");
      assert.equal(values[FIELDS.accentedName], "Onestà");
      assert.equal(values[FIELDS.agree], true);
      assert.equal(values[FIELDS.clan], "Verde");
      assert.equal(values[FIELDS.school], "Sud");
      await waitForView(target, (s) => s.dirty, "dirty after importing");
      await vscode.commands.executeCommand("workbench.action.files.revert");
    });
  }

  test("extracted pages keep the form values (Print Pages)", async () => {
    const uri = await open("pages.pdf", await createDocumentFixture(5));
    const data = await request<Uint8Array>(uri, { kind: "pages", pages: [2, 4, 5] });
    const pdf = await PDFDocument.load(data);
    assert.equal(pdf.getPageCount(), 3);

    const form = await open("pages-form.pdf", await createFormFixture());
    await vscode.commands.executeCommand("pdfTools.test.setFieldValues", form.toString(), { [FIELDS.name]: "Stampato" });
    const formPdf = await PDFDocument.load(await request<Uint8Array>(form, { kind: "pages", pages: [1] }));
    assert.equal(formPdf.getForm().getTextField(FIELDS.name).getText(), "Stampato");
    await vscode.commands.executeCommand("workbench.action.files.revert");
  });

  test("text and page image export", async () => {
    const uri = await open("text.pdf", await createDocumentFixture());
    const text = await request<string>(uri, { kind: "text" });
    assert.match(text, /^--- Page 1 ---\n/);
    for (const page of DOCUMENT_PAGES) {
      assert.ok(text.includes(page), `contains "${page}"`);
    }

    const png = await request<Uint8Array>(uri, { kind: "pageImage", page: 2 });
    assert.deepEqual([...png.slice(0, 4)], [0x89, 0x50, 0x4e, 0x47], "PNG signature");

    await vscode.commands.executeCommand("pdfTools.openText");
    const editor = await waitFor(() => vscode.window.activeTextEditor, "text editor");
    assert.ok(editor.document.getText().includes(DOCUMENT_PAGES[2]));
    assert.equal(editor.document.uri.scheme, "untitled");
    await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
  });

  test("a copied page link opens the document at that page", async () => {
    const uri = await open("link.pdf", await createDocumentFixture(8));
    await vscode.commands.executeCommand("pdfTools.test.goToPage", uri.toString(), "6");
    await waitForView(uri, (s) => s.view.page === 6, "page 6");
    await waitFor(
      async () => (await vscode.commands.executeCommand<{ page: number } | undefined>("pdfTools.test.getStatus", uri.toString()))?.page === 6,
      "status page 6",
    );
    await vscode.commands.executeCommand("pdfTools.copyPageLink");
    const link = await vscode.env.clipboard.readText();
    assert.match(link, /^vscode(-insiders)?:\/\/ryadel\.pdf-tools\/open\?page=6&file=/);

    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    // Remembered at page 6 too: start from page 1 so the link is what moves it.
    await vscode.commands.executeCommand("vscode.openWith", uri, VIEW_TYPE);
    await waitForLoaded(uri);
    await vscode.commands.executeCommand("pdfTools.test.goToPage", uri.toString(), "1");
    await waitForView(uri, (s) => s.view.page === 1, "page 1");
    await waitFor(async () => (await vscode.commands.executeCommand<{ page: number } | undefined>("pdfTools.test.getRememberedView", uri.toString()))?.page === 1, "remembered page 1");
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");

    await vscode.commands.executeCommand("pdfTools.test.openLink", link);
    await waitForLoaded(uri);
    await waitForView(uri, (s) => s.view.page === 6, "opened at page 6");

    // Already open: the link moves the editor.
    await vscode.commands.executeCommand("pdfTools.test.openLink", link.replace("page=6", "page=3"));
    await waitForView(uri, (s) => s.view.page === 3, "moved to page 3");
  });

  test("presentation mode fits one page and restores the view", async () => {
    const uri = await open("present.pdf", await createDocumentFixture(4));
    await vscode.commands.executeCommand("pdfTools.fitWidth");
    await waitForView(uri, (s) => s.view.scaleValue === "page-width", "fit width");

    await vscode.commands.executeCommand("pdfTools.presentationMode");
    const presenting = await waitForView(uri, (s) => s.presenting, "presenting");
    assert.equal(presenting.view.scrollMode, "page");
    assert.equal(presenting.view.scaleValue, "page-fit");
    assert.equal(presenting.sidebarOpen, false);

    await vscode.commands.executeCommand("pdfTools.presentationMode");
    const restored = await waitForView(uri, (s) => !s.presenting, "presentation ended");
    assert.equal(restored.view.scrollMode, "vertical");
    assert.equal(restored.view.scaleValue, "page-width");
  });

  test("toolbar and page color settings apply live; commands toggle them per editor", async () => {
    const uri = await open("settings.pdf", await createDocumentFixture());
    const config = vscode.workspace.getConfiguration("pdfTools");
    try {
      await config.update("pageColors", "theme", vscode.ConfigurationTarget.Global);
      await config.update("toolbar", "floating", vscode.ConfigurationTarget.Global);
      await waitForView(uri, (s) => s.pageColors && s.focus, "settings applied");

      await vscode.commands.executeCommand("pdfTools.togglePageColors");
      await vscode.commands.executeCommand("pdfTools.toggleFocusMode");
      await waitForView(uri, (s) => !s.pageColors && !s.focus, "toggled off in this editor");
    } finally {
      await config.update("pageColors", undefined, vscode.ConfigurationTarget.Global);
      await config.update("toolbar", undefined, vscode.ConfigurationTarget.Global);
    }
  });
});
