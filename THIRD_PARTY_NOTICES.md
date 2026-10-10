# Third-party notices

PDF Tools is licensed under the MIT License (see [LICENSE](LICENSE)). It bundles the following third-party software. Their license texts are included in the extension package next to the bundled files (`dist/webview/`).

| Component | Copyright | License | License file in the package |
|---|---|---|---|
| [PDF.js](https://github.com/mozilla/pdf.js) (`pdfjs-dist`) — viewer, form filling and saving | Mozilla Foundation and contributors | Apache License 2.0 | `dist/webview/LICENSE_PDFJS` |
| PDF.js standard fonts — Foxit fonts | PDFium Authors | BSD 3-Clause | `dist/webview/standard_fonts/LICENSE_FOXIT` |
| PDF.js standard fonts — Liberation Sans | Red Hat, Inc. | GNU GPL v2 with font exception (Liberation font license agreement) | `dist/webview/standard_fonts/LICENSE_LIBERATION` |
| PDF.js CMaps | Adobe Systems Incorporated | BSD 3-Clause | `dist/webview/cmaps/LICENSE` |
| OpenJPEG (JPEG 2000 decoder, WebAssembly) | OpenJPEG contributors; Mozilla Foundation | BSD 2-Clause | `dist/webview/wasm/LICENSE_OPENJPEG`, `LICENSE_PDFJS_OPENJPEG` |
| JBIG2 decoder (WebAssembly, from PDFium) | PDFium Authors; Mozilla Foundation | BSD 3-Clause; Apache License 2.0 | `dist/webview/wasm/LICENSE_JBIG2`, `LICENSE_PDFJS_JBIG2` |
| qcms (color management, WebAssembly) | Mozilla Corporation; Marti Maria | MIT | `dist/webview/wasm/LICENSE_QCMS`, `LICENSE_PDFJS_QCMS` |
| CGATS001Compat ICC profile | see file | CC0 1.0 | `dist/webview/iccs/LICENSE` |
| [Codicons](https://github.com/microsoft/vscode-codicons) (`@vscode/codicons`) — toolbar icons | Microsoft Corporation | CC BY 4.0 | `dist/webview/codicons/LICENSE` |

The Liberation and Foxit font files are shipped unmodified, as separate files, exactly as distributed in `pdfjs-dist`; they are loaded at runtime to display PDFs that use non-embedded standard fonts.

Development-only dependencies (not shipped in the extension), such as `pdf-lib` (MIT), `esbuild` (MIT) and `typescript` (Apache 2.0), are listed in `package.json`.
