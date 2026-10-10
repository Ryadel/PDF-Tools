import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import type { WebviewConfig } from "../shared/protocol";

/** Root of the webview bundle and its assets, relative to the extension. */
export function webviewRoot(extensionUri: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(extensionUri, "dist", "webview");
}

export function getWebviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const root = webviewRoot(extensionUri);
  const asset = (...path: string[]) => webview.asWebviewUri(vscode.Uri.joinPath(root, ...path)).toString();
  const nonce = randomBytes(16).toString("base64");

  const config: WebviewConfig = {
    workerUrl: asset("pdf.worker.mjs"),
    // PDF.js expects directory URLs to end with a slash.
    standardFontDataUrl: `${asset("standard_fonts")}/`,
    cMapUrl: `${asset("cmaps")}/`,
    wasmUrl: `${asset("wasm")}/`,
    iccUrl: `${asset("iccs")}/`,
    language: vscode.env.language,
    // The same bundle as the host's vscode.l10n.t(): webview strings live in l10n/ too.
    l10n: vscode.l10n.bundle,
  };

  // - 'wasm-unsafe-eval': PDF.js decodes JPEG 2000 / JBIG2 and manages colors
  //   with WebAssembly. It does not allow JavaScript eval().
  // - worker-src blob: the PDF.js worker runs from a Blob URL, because webview
  //   resources live on a different origin than the webview document.
  // - connect-src: the webview fetches the worker script, fonts, CMaps and WASM.
  const csp = [
    "default-src 'none'",
    `script-src 'nonce-${nonce}' 'wasm-unsafe-eval'`,
    `style-src ${webview.cspSource}`,
    `img-src ${webview.cspSource} data: blob:`,
    `font-src ${webview.cspSource} data:`,
    `connect-src ${webview.cspSource}`,
    "worker-src blob:",
  ].join("; ");

  return /* html */ `<!DOCTYPE html>
<html lang="${escapeAttribute(vscode.env.language)}">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${asset("codicons", "codicon.css")}">
  <link rel="stylesheet" href="${asset("pdf_viewer.css")}">
  <link rel="stylesheet" href="${asset("styles.css")}">
  <title>PDF Tools</title>
</head>
<body data-config="${escapeAttribute(JSON.stringify(config))}">
  <div id="toolbar" class="toolbar" role="toolbar" aria-label="${escapeAttribute(vscode.l10n.t("PDF toolbar"))}"></div>
  <div id="toolbar2" class="toolbar tools-row" role="toolbar" aria-label="${escapeAttribute(vscode.l10n.t("Mode tools"))}"></div>
  <div id="banner" role="status" hidden>
    <span class="codicon"></span>
    <span id="bannerText"></span>
    <button id="bannerClose" class="icon" title="${escapeAttribute(vscode.l10n.t("Dismiss"))}" aria-label="${escapeAttribute(vscode.l10n.t("Dismiss"))}"><span class="codicon codicon-close"></span></button>
  </div>
  <div id="main">
    <nav id="strip" aria-label="${escapeAttribute(vscode.l10n.t("Sidebar panels"))}"></nav>
    <aside id="sidebar" hidden></aside>
    <div id="canvasArea">
      <div id="viewerContainer" tabindex="0">
        <div id="viewer" class="pdfViewer"></div>
      </div>
    </div>
  </div>
  <script type="module" nonce="${nonce}" src="${asset("main.js")}"></script>
</body>
</html>`;
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
