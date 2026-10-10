import * as vscode from "vscode";
import type { EditorPanel } from "./editor/editorPanel";

/** Zoom preset names, translated (also used by the Zoom Presets quick pick). */
export function presetLabels(): Record<string, string> {
  return {
    auto: vscode.l10n.t("Automatic"),
    "page-actual": vscode.l10n.t("Actual Size"),
    "page-fit": vscode.l10n.t("Page Fit"),
    "page-width": vscode.l10n.t("Page Width"),
  };
}

/**
 * Status bar items for the active PDF editor (like VS Code's image preview):
 * page (click: Go to Page), zoom (click: presets), form state (click: fields).
 * Also maintains the context keys used by keybindings.
 */
export class PdfStatusBar implements vscode.Disposable {
  readonly #page = vscode.window.createStatusBarItem("pdfTools.page", vscode.StatusBarAlignment.Right, 102);
  readonly #zoom = vscode.window.createStatusBarItem("pdfTools.zoom", vscode.StatusBarAlignment.Right, 101);
  readonly #form = vscode.window.createStatusBarItem("pdfTools.form", vscode.StatusBarAlignment.Right, 100);

  constructor() {
    this.#page.name = vscode.l10n.t("PDF Page");
    this.#page.command = "pdfTools.goToPage";
    this.#zoom.name = vscode.l10n.t("PDF Zoom");
    this.#zoom.command = "pdfTools.pickZoom";
    this.#form.name = vscode.l10n.t("PDF Form");
    this.#form.command = "pdfTools.showFields";
  }

  update(panel: EditorPanel | undefined): void {
    const status = panel?.status;
    void vscode.commands.executeCommand("setContext", "pdfTools.canGoBack", !!status?.canGoBack);
    void vscode.commands.executeCommand("setContext", "pdfTools.canGoForward", !!status?.canGoForward);
    if (!status) {
      this.#page.hide();
      this.#zoom.hide();
      this.#form.hide();
      return;
    }
    this.#page.text = status.pageLabel
      ? vscode.l10n.t("Page {0} ({1} of {2})", status.pageLabel, status.page, status.pageCount)
      : vscode.l10n.t("Page {0} of {1}", status.page, status.pageCount);
    this.#page.tooltip = vscode.l10n.t("Go to Page… (Ctrl+G)");
    this.#page.show();

    const percent = `${Math.round(status.scale * 100)}%`;
    this.#zoom.text = status.scalePreset ? `${presetLabels()[status.scalePreset] ?? status.scalePreset} · ${percent}` : percent;
    this.#zoom.tooltip = vscode.l10n.t("Zoom presets");
    this.#zoom.show();

    if (status.hasForm) {
      const parts = [status.mode === "fill" ? vscode.l10n.t("Fill") : vscode.l10n.t("View")];
      if (status.changedFields > 0) {
        parts.push(vscode.l10n.t("{0} changed", status.changedFields));
      }
      if (status.requiredEmpty > 0) {
        parts.push(vscode.l10n.t("{0} required", status.requiredEmpty));
      }
      this.#form.text = `$(symbol-field) ${parts.join(" · ")}`;
      this.#form.tooltip = vscode.l10n.t("Form fields: changed values not yet saved, required fields still empty");
      this.#form.show();
    } else {
      this.#form.hide();
    }
  }

  dispose(): void {
    this.#page.dispose();
    this.#zoom.dispose();
    this.#form.dispose();
  }
}
