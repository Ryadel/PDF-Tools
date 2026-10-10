// `pdfjs-dist/web/pdf_viewer.mjs` reads the PDF.js API from
// `globalThis.pdfjsLib` when it is evaluated, so this module must be imported
// before it (ES modules evaluate in import order).
import * as pdfjsLib from "pdfjs-dist";

Object.assign(globalThis, { pdfjsLib });
