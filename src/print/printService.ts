import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join, parse } from "node:path";
import * as vscode from "vscode";
import type { EditorPanel } from "../editor/editorPanel";
import { errorMessage, log } from "../log";
import { formatPageRanges } from "../shared/pageRanges";
import { deleteOldTempFiles, PRINT_TEMP_FOLDER } from "../tempFiles";

/**
 * Printing for PDF Tools.
 *
 * VS Code webviews cannot print: their iframes are sandboxed without
 * `allow-modals`, so `window.print()` is ignored. Instead, the current bytes
 * (including unsaved form changes) are written to a temporary file that the
 * system PDF application prints.
 */

type PrintMethod = "systemViewer" | "windowsPrintVerb";

const PRINT_VERB_TIMEOUT_MS = 30_000;

/** Prints the document, or only `pages` (1-based, sorted) of it. Form values are included. */
export async function printPanel(panel: EditorPanel, pages?: number[]): Promise<void> {
  const { document } = panel;
  try {
    const data = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: vscode.l10n.t("Preparing '{0}' for printing", document.fileName) },
      () => (pages ? panel.request({ kind: "pages", pages }) : document.getCurrentBytes(panel)),
    );
    // The pages show in the PDF application's title: "sheet-p1-3_7-print-….pdf".
    const file = await writeTempCopy(document.fileName, data, pages ? `-p${formatPageRanges(pages).replace(/, /g, "_")}` : "");
    const method = vscode.workspace.getConfiguration("pdfTools").get<PrintMethod>("print.method", "systemViewer");

    if (method === "windowsPrintVerb" && process.platform === "win32") {
      try {
        await printWithShellVerb(file);
        vscode.window.setStatusBarMessage(vscode.l10n.t("Sent '{0}' to the default PDF application for printing.", document.fileName), 5_000);
        return;
      } catch (error) {
        log().warn(`Print verb failed for ${file}: ${errorMessage(error)}. Falling back to the system viewer.`);
      }
    }

    if (!(await vscode.env.openExternal(vscode.Uri.file(file)))) {
      throw new Error(vscode.l10n.t("The system PDF application could not be opened."));
    }
    vscode.window.setStatusBarMessage(
      vscode.l10n.t("Opened a copy of '{0}' in your PDF application. Print it from there.", document.fileName),
      8_000,
    );
  } catch (error) {
    log().error(`Print failed for ${document.uri.toString(true)}: ${errorMessage(error)}`);
    void vscode.window.showErrorMessage(vscode.l10n.t("Could not print '{0}': {1}", document.fileName, errorMessage(error)));
  }
}

async function writeTempCopy(fileName: string, data: Uint8Array, suffix: string): Promise<string> {
  await mkdir(PRINT_TEMP_FOLDER, { recursive: true });
  void deleteOldTempFiles();
  const { name } = parse(fileName);
  const file = join(PRINT_TEMP_FOLDER, `${name}${suffix}-print-${Date.now()}.pdf`);
  await writeFile(file, data);
  return file;
}

/** Runs the file's "Print" shell verb (Windows Explorer's right-click > Print). */
function printWithShellVerb(file: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      // The path is passed through the environment, never interpolated into the script.
      ["-NoProfile", "-NonInteractive", "-Command", "Start-Process -FilePath $env:PDF_TOOLS_PRINT_FILE -Verb Print"],
      { env: { ...process.env, PDF_TOOLS_PRINT_FILE: file }, windowsHide: true, timeout: PRINT_VERB_TIMEOUT_MS },
      (error, _stdout, stderr) => (error ? reject(new Error(stderr.trim() || error.message)) : resolve()),
    );
  });
}
