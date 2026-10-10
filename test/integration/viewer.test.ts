// v0.2 viewer features end to end: modes, navigation and view commands,
// find, remembered view state, status bar, password-protected PDFs.

import * as assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as vscode from "vscode";
import { createDocumentFixture, createEncryptedFixture } from "../fixtures/createDocumentFixture";
import { createFormFixture } from "../fixtures/createFormFixture";

const VIEW_TYPE = "pdfTools.editor";

interface ViewState {
  view: { page: number; scaleValue: string; rotation: number; scrollMode: string; spreadMode: string };
  mode: string;
  cursor: string;
  sidebarOpen: boolean;
  panel: string;
  hasForm: boolean;
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

function waitForRemembered(uri: vscode.Uri, check: (view: { page: number; rotation: number }) => boolean): Promise<unknown> {
  return waitFor(async () => {
    const view = await vscode.commands.executeCommand<{ page: number; rotation: number } | undefined>("pdfTools.test.getRememberedView", uri.toString());
    return view && check(view);
  }, "remembered view");
}

const viewState = (uri: vscode.Uri) => vscode.commands.executeCommand<ViewState>("pdfTools.test.getViewState", uri.toString());

async function waitForView(uri: vscode.Uri, check: (state: ViewState) => boolean, what: string): Promise<ViewState> {
  return waitFor(async () => {
    const state = await viewState(uri);
    return check(state) ? state : undefined;
  }, what);
}

suite("PDF Tools viewer (0.2)", () => {
  let folder: string;

  suiteSetup(async () => {
    folder = await mkdtemp(join(tmpdir(), "pdf-tools-viewer-"));
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

  test("auto mode: forms open in Fill, other documents in View", async () => {
    const form = await open("auto-form.pdf", await createFormFixture());
    let state = await viewState(form);
    assert.equal(state.hasForm, true);
    assert.equal(state.mode, "fill");
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");

    const plain = await open("auto-plain.pdf", await createDocumentFixture());
    state = await viewState(plain);
    assert.equal(state.hasForm, false);
    assert.equal(state.mode, "view");
  });

  test("navigation and view commands", async () => {
    const uri = await open("commands.pdf", await createDocumentFixture());
    const run = (command: string) => vscode.commands.executeCommand(`pdfTools.${command}`);

    await run("lastPage");
    await waitForView(uri, (s) => s.view.page === 3, "last page");
    await run("firstPage");
    await waitForView(uri, (s) => s.view.page === 1, "first page");
    await run("nextPage");
    await waitForView(uri, (s) => s.view.page === 2, "next page");
    await run("back");
    await waitForView(uri, (s) => s.view.page === 1, "back");

    await run("rotateClockwise");
    await waitForView(uri, (s) => s.view.rotation === 90, "rotation 90");
    await run("rotateCounterclockwise");
    await waitForView(uri, (s) => s.view.rotation === 0, "rotation 0");

    await run("fitWidth");
    await waitForView(uri, (s) => s.view.scaleValue === "page-width", "fit width");
    await run("zoomActual");
    await waitForView(uri, (s) => s.view.scaleValue === "page-actual", "actual size");

    await run("scrollWrapped");
    await waitForView(uri, (s) => s.view.scrollMode === "wrapped", "wrapped scrolling");
    await run("spreadOdd");
    await waitForView(uri, (s) => s.view.spreadMode === "odd", "odd spreads");
    await run("scrollVertical");
    await run("spreadNone");

    await run("handTool");
    await waitForView(uri, (s) => s.cursor === "hand", "hand tool");
    await run("selectTool");

    await run("showOutline");
    await waitForView(uri, (s) => s.sidebarOpen && s.panel === "outline", "outline panel");

    const status = await waitFor(
      async () => vscode.commands.executeCommand<{ page: number; pageCount: number } | undefined>("pdfTools.test.getStatus", uri.toString()),
      "status bar status",
    );
    assert.equal(status.pageCount, 3);
  });

  test("find ignores accents and case by default, options narrow it", async () => {
    const uri = await open("find.pdf", await createDocumentFixture());
    type Result = { total: number; pages: { page: number; count: number }[] };
    const find = (query: string, options?: object) =>
      vscode.commands.executeCommand<Result>("pdfTools.test.find", uri.toString(), query, options);

    let result = await find("onesta");
    assert.equal(result.total, 3, "onestà (p.1), Onestà and ONESTÀ (p.3); 'onesto' (p.2) does not match");
    assert.deepEqual(result.pages.map((page) => [page.page, page.count]), [[1, 1], [3, 2]]);

    result = await find("onesta", { matchDiacritics: true });
    assert.equal(result.total, 0, "with diacritics, 'onesta' ≠ 'onestà'");

    result = await find("Onestà", { caseSensitive: true });
    assert.equal(result.total, 1);

    result = await find("onest", { entireWord: true });
    assert.equal(result.total, 0, "'onest' is never a whole word");
  });

  test("reopens a document where it was left", async () => {
    // A middle page of a long document: the last pages cannot scroll to the top,
    // so PDF.js would report the most visible page instead.
    const uri = await open("remember.pdf", await createDocumentFixture(10));
    await vscode.commands.executeCommand("pdfTools.rotateClockwise");
    await vscode.commands.executeCommand("pdfTools.test.goToPage", uri.toString(), "5");
    await waitForView(uri, (s) => s.view.page === 5 && s.view.rotation === 90, "page 5, rotated");
    // The view state is saved a moment after the last change: wait for it, not for a fixed time.
    await waitForRemembered(uri, (view) => view.page === 5 && view.rotation === 90);
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");

    await vscode.commands.executeCommand("vscode.openWith", uri, VIEW_TYPE);
    await waitForLoaded(uri);
    const state = await waitForView(uri, (s) => s.view.page === 5, "restored page");
    assert.equal(state.view.rotation, 90);
  });

  test("asks for the password of a protected PDF", async () => {
    const uri = vscode.Uri.file(join(folder, "protected.pdf"));
    await writeFile(uri.fsPath, await createEncryptedFixture("segreto"));
    // In test mode the host answers the password prompt with this value
    // (the input box itself is checked manually).
    await vscode.commands.executeCommand("pdfTools.test.setNextPassword", "segreto");
    await vscode.commands.executeCommand("vscode.openWith", uri, VIEW_TYPE);
    await waitForLoaded(uri);
    const state = await viewState(uri);
    assert.equal(state.view.page, 1);
  });
});
