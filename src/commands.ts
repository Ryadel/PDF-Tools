import { posix } from "node:path";
import * as vscode from "vscode";
import type { EditorPanel } from "./editor/editorPanel";
import type { PdfEditorProvider } from "./editor/pdfEditorProvider";
import { errorMessage, log } from "./log";
import { printPanel } from "./print/printService";
import { isUriTarget, PAGE_LINK_PATH, pageLinkQuery, parsePageLinkQuery } from "./shared/pageLinks";
import { parsePageRanges } from "./shared/pageRanges";
import { presetLabels } from "./statusBar";
import type { FormDataFormat, HostCommand, ViewerCommand } from "./shared/protocol";

/** Viewer actions exposed as `pdfTools.<command>` (Command Palette, keybindings, menus). */
export const VIEWER_COMMANDS: readonly ViewerCommand[] = [
  "firstPage", "lastPage", "nextPage", "previousPage", "back", "forward",
  "zoomIn", "zoomOut", "zoomActual", "zoomAuto", "fitWidth", "fitPage",
  "rotateClockwise", "rotateCounterclockwise",
  "find", "findNext", "findPrevious", "showSearch",
  "toggleSidebar", "showThumbnails", "showOutline", "showFields", "showAttachments", "showLayers", "showProperties",
  "viewMode", "fillMode",
  "selectTool", "handTool",
  "scrollVertical", "scrollHorizontal", "scrollWrapped", "scrollPage",
  "spreadNone", "spreadOdd", "spreadEven",
  "toggleFieldHighlight", "nextField", "previousField", "nextRequiredField",
  "toggleFocusMode", "togglePageColors", "presentationMode", "copyPageImage",
];

const ZOOM_PRESETS: [value: string, label?: string][] = [
  ["auto"],
  ["page-actual"],
  ["page-fit"],
  ["page-width"],
  ["0.5", "50%"],
  ["0.75", "75%"],
  ["1", "100%"],
  ["1.25", "125%"],
  ["1.5", "150%"],
  ["2", "200%"],
  ["3", "300%"],
  ["4", "400%"],
];

/** Text extraction and page extraction read the whole document: allow time. */
const LONG_REQUEST_MS = 300_000;

export function registerCommands(context: vscode.ExtensionContext, provider: PdfEditorProvider): vscode.Disposable {
  const withPanel = (run: (panel: EditorPanel) => unknown) => () => {
    const panel = provider.activePanel;
    if (!panel) {
      void vscode.window.showInformationMessage(vscode.l10n.t("Open a PDF in PDF Tools first."));
      return;
    }
    return run(panel);
  };

  const viewerCommands = VIEWER_COMMANDS.map((command) =>
    vscode.commands.registerCommand(
      `pdfTools.${command}`,
      withPanel((panel) => {
        if (command === "copyPageImage") {
          // The webview writes to the clipboard, which needs focus (the Command Palette has it).
          panel.webviewPanel.reveal(undefined, false);
        }
        panel.post({ type: "command", command });
      }),
    ),
  );

  const hostCommands: Record<HostCommand | "pdfTools.pickZoom", (panel: EditorPanel) => unknown> = {
    "pdfTools.save": (panel) => vscode.workspace.save(panel.document.uri),
    "pdfTools.saveAs": (panel) => vscode.workspace.saveAs(panel.document.uri),
    "pdfTools.print": (panel) => printPanel(panel),
    "pdfTools.printPages": (panel) => printPages(panel),
    "pdfTools.goToPage": (panel) => goToPage(panel),
    "pdfTools.copyPageLink": (panel) => copyPageLink(context, panel),
    "pdfTools.openText": (panel) => openText(panel),
    "pdfTools.exportPageImage": (panel) => exportPageImage(panel),
    "pdfTools.clearForm": (panel) => clearForm(panel),
    "pdfTools.exportFormData": (panel) => exportFormData(panel),
    "pdfTools.importFormData": (panel) => importFormData(panel),
    "pdfTools.pickZoom": (panel) => pickZoom(panel),
    "pdfTools.openSettings": () =>
      vscode.commands.executeCommand("workbench.action.openSettings", `@ext:${context.extension.id}`),
  };
  provider.setHostCommandRunner((command, panel) => void hostCommands[command](panel));

  return vscode.Disposable.from(
    ...viewerCommands,
    ...Object.entries(hostCommands).map(([id, run]) => vscode.commands.registerCommand(id, withPanel(run))),
    vscode.window.registerUriHandler({ handleUri: (uri) => openPageLink(provider, uri) }),
  );
}

async function goToPage(panel: EditorPanel): Promise<void> {
  const status = panel.status;
  const count = status?.pageCount ?? 0;
  const page = await vscode.window.showInputBox({
    title: vscode.l10n.t("Go to Page"),
    prompt: vscode.l10n.t("Page number (1–{0}) or page label", count),
    value: status?.pageLabel ?? String(status?.page ?? ""),
    valueSelection: [0, Number.MAX_SAFE_INTEGER],
  });
  if (page?.trim()) {
    panel.post({ type: "goToPage", page: page.trim() });
    panel.webviewPanel.reveal(undefined, false);
  }
}

async function pickZoom(panel: EditorPanel): Promise<void> {
  const current = panel.status?.scalePreset ?? String(panel.status?.scale ?? "");
  const names = presetLabels();
  const items = ZOOM_PRESETS.map(([value, label]) => ({ label: label ?? names[value], value, picked: value === current }));
  const choice = await vscode.window.showQuickPick(items, { title: vscode.l10n.t("Zoom"), placeHolder: vscode.l10n.t("Select a zoom level") });
  if (choice) {
    panel.post({ type: "setScale", value: choice.value });
  }
}

async function clearForm(panel: EditorPanel): Promise<void> {
  const clear = vscode.l10n.t("Clear Form");
  const answer = await vscode.window.showWarningMessage(
    vscode.l10n.t("Clear all form fields in '{0}'?", panel.document.fileName),
    {
      modal: true,
      detail: vscode.l10n.t("Fields go back to their default values (usually empty). Until you save, File: Revert File restores the saved values."),
    },
    clear,
  );
  if (answer === clear) {
    panel.post({ type: "command", command: "clearForm" });
  }
}

// --- Print pages ------------------------------------------------------------------

async function printPages(panel: EditorPanel): Promise<void> {
  const count = panel.status?.pageCount ?? 0;
  const current = panel.status?.page ?? 1;
  const currentLabel = panel.status?.pageLabel ?? String(current);
  type Choice = vscode.QuickPickItem & { choice: "current" | "range" | "all" };
  const picked = await vscode.window.showQuickPick<Choice>(
    [
      { label: vscode.l10n.t("Current Page"), description: vscode.l10n.t("Page {0}", currentLabel), choice: "current" },
      { label: vscode.l10n.t("Pages…"), description: vscode.l10n.t("For example 1-3, 7, 10-"), choice: "range" },
      { label: vscode.l10n.t("All Pages"), description: vscode.l10n.t("{0} pages", count), choice: "all" },
    ],
    { title: vscode.l10n.t("Print '{0}'", panel.document.fileName), placeHolder: vscode.l10n.t("Which pages?") },
  );
  if (!picked) {
    return;
  }
  let pages: number[] | undefined;
  if (picked.choice === "current") {
    pages = [current];
  } else if (picked.choice === "range") {
    const text = await vscode.window.showInputBox({
      title: vscode.l10n.t("Print Pages"),
      prompt: vscode.l10n.t("Pages and ranges separated by commas (1–{0}). '10-' runs to the last page.", count),
      value: String(current),
      validateInput: (value) =>
        parsePageRanges(value, count) ? undefined : vscode.l10n.t("Enter pages between 1 and {0}, like 1-3, 7, 10-", count),
    });
    pages = text === undefined ? undefined : parsePageRanges(text, count);
    if (!pages) {
      return;
    }
  }
  await printPanel(panel, pages && pages.length < count ? pages : undefined);
}

// --- Links, text, images -----------------------------------------------------------

async function copyPageLink(context: vscode.ExtensionContext, panel: EditorPanel): Promise<void> {
  const { uri } = panel.document;
  const page = panel.status?.page ?? 1;
  const target = uri.scheme === "file" ? uri.fsPath : uri.toString();
  const link = `${vscode.env.uriScheme}://${context.extension.id.toLowerCase()}${PAGE_LINK_PATH}?${pageLinkQuery(target, page)}`;
  await vscode.env.clipboard.writeText(link);
  vscode.window.setStatusBarMessage(
    vscode.l10n.t("Copied a link to page {0} of '{1}'.", panel.status?.pageLabel ?? String(page), panel.document.fileName),
    5_000,
  );
}

/** `vscode://ryadel.pdf-tools/open?page=12&file=…` → opens the file at that page. */
export async function openPageLink(provider: PdfEditorProvider, uri: vscode.Uri): Promise<void> {
  const link = uri.path === PAGE_LINK_PATH ? parsePageLinkQuery(uri.query) : undefined;
  if (!link) {
    void vscode.window.showErrorMessage(vscode.l10n.t("This PDF Tools link is not valid: {0}", uri.toString(true)));
    return;
  }
  const target = isUriTarget(link.target) ? vscode.Uri.parse(link.target, true) : vscode.Uri.file(link.target);
  try {
    await provider.openAtPage(target, link.page);
  } catch (error) {
    void vscode.window.showErrorMessage(vscode.l10n.t("Could not open {0}: {1}", link.target, errorMessage(error)));
  }
}

async function openText(panel: EditorPanel): Promise<void> {
  const { document } = panel;
  try {
    const text = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t("Extracting the text of '{0}'…", document.fileName) },
      () => panel.request({ kind: "text" }, LONG_REQUEST_MS),
    );
    if (!/\S/.test(text.replace(/^--- .* ---$/gm, ""))) {
      void vscode.window.showInformationMessage(
        vscode.l10n.t("'{0}' has no text to extract. It may contain only scanned images.", document.fileName),
      );
      return;
    }
    // An untitled document named after the PDF: saving it proposes `<name>.txt` next to it.
    const name = `${posix.parse(document.fileName).name}.txt`;
    const untitled = vscode.Uri.joinPath(document.uri, "..", name).with({ scheme: "untitled" });
    const textDocument = await vscode.workspace.openTextDocument(untitled);
    const editor = await vscode.window.showTextDocument(textDocument, { preview: false });
    const all = new vscode.Range(0, 0, textDocument.lineCount, 0);
    await editor.edit((edit) => edit.replace(all, text));
    editor.selection = new vscode.Selection(0, 0, 0, 0);
  } catch (error) {
    log().error(`Text extraction failed for ${document.uri.toString(true)}: ${errorMessage(error)}`);
    void vscode.window.showErrorMessage(vscode.l10n.t("Could not extract the text of '{0}': {1}", document.fileName, errorMessage(error)));
  }
}

async function exportPageImage(panel: EditorPanel): Promise<void> {
  const { document } = panel;
  const page = panel.status?.page ?? 1;
  const target = await vscode.window.showSaveDialog({
    title: vscode.l10n.t("Export Page as PNG"),
    defaultUri: vscode.Uri.joinPath(document.uri, "..", `${posix.parse(document.fileName).name}-p${page}.png`),
    filters: { [vscode.l10n.t("PNG image")]: ["png"] },
  });
  if (!target) {
    return;
  }
  try {
    const data = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: vscode.l10n.t("Rendering page {0}", page) },
      () => panel.request({ kind: "pageImage", page }),
    );
    await vscode.workspace.fs.writeFile(target, data);
    vscode.window.setStatusBarMessage(vscode.l10n.t("Saved page {0} as {1}.", page, posix.basename(target.path)), 5_000);
  } catch (error) {
    void vscode.window.showErrorMessage(vscode.l10n.t("Could not export page {0}: {1}", page, errorMessage(error)));
  }
}

// --- Form data ------------------------------------------------------------------------

function formatOf(uri: vscode.Uri): FormDataFormat {
  return posix.extname(uri.path).toLowerCase() === ".xfdf" ? "xfdf" : "json";
}

async function exportFormData(panel: EditorPanel): Promise<void> {
  const { document } = panel;
  const target = await vscode.window.showSaveDialog({
    title: vscode.l10n.t("Export Form Data"),
    defaultUri: vscode.Uri.joinPath(document.uri, "..", `${posix.parse(document.fileName).name}.json`),
    filters: { JSON: ["json"], XFDF: ["xfdf"] },
  });
  if (!target) {
    return;
  }
  try {
    const text = await panel.request({ kind: "exportForm", format: formatOf(target), fileName: document.fileName });
    await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(text));
    vscode.window.setStatusBarMessage(vscode.l10n.t("Exported the form data to {0}.", posix.basename(target.path)), 5_000);
  } catch (error) {
    void vscode.window.showErrorMessage(vscode.l10n.t("Could not export the form data: {0}", errorMessage(error)));
  }
}

async function importFormData(panel: EditorPanel): Promise<void> {
  const [source] =
    (await vscode.window.showOpenDialog({
      title: vscode.l10n.t("Import Form Data"),
      defaultUri: vscode.Uri.joinPath(panel.document.uri, ".."),
      filters: { [vscode.l10n.t("Form data (JSON, XFDF)")]: ["json", "xfdf"] },
      canSelectMany: false,
    })) ?? [];
  if (!source) {
    return;
  }
  const name = posix.basename(source.path);
  try {
    const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(source));
    const { applied, unknown } = await panel.request({ kind: "importForm", format: formatOf(source), text });
    if (applied === 0) {
      void vscode.window.showWarningMessage(vscode.l10n.t("No field in {0} matches this form.", name));
      return;
    }
    const message = vscode.l10n.t("Imported {0} field values from {1}.", applied, name);
    void vscode.window.showInformationMessage(
      unknown.length === 0
        ? message
        : `${message} ${vscode.l10n.t("Ignored {0} fields that this form does not have: {1}", unknown.length, unknown.slice(0, 5).join(", "))}${unknown.length > 5 ? "…" : ""}`,
    );
  } catch (error) {
    void vscode.window.showErrorMessage(vscode.l10n.t("Could not import {0}: {1}", name, errorMessage(error)));
  }
}
