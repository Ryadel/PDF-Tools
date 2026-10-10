import { PDFDocument as EncryptablePDFDocument, StandardFonts as EncryptableFonts } from "@cantoo/pdf-lib";
import { PDFDocument, StandardFonts } from "pdf-lib";

/** Text of each page of the plain document (one string per page). */
export const DOCUMENT_PAGES = [
  "Capitolo 1. L'onestà è la prima virtù del samurai.",
  "Capitolo 2. Un samurai onesto non mente mai.",
  "Capitolo 3. Onestà e cortesia vanno insieme. ONESTÀ.",
];

/**
 * A text document without form fields (opens in View mode): the pages of
 * DOCUMENT_PAGES, then filler pages up to `pageCount`.
 */
export async function createDocumentFixture(pageCount = DOCUMENT_PAGES.length): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const texts = [...DOCUMENT_PAGES, ...Array.from({ length: Math.max(0, pageCount - DOCUMENT_PAGES.length) }, (_, i) => `Pagina ${DOCUMENT_PAGES.length + i + 1}`)];
  for (const text of texts) {
    pdf.addPage([595, 842]).drawText(text, { x: 50, y: 780, size: 14, font });
  }
  return pdf.save();
}

/** A one-page document encrypted with a user password. */
export async function createEncryptedFixture(userPassword: string): Promise<Uint8Array> {
  const pdf = await EncryptablePDFDocument.create();
  const font = await pdf.embedFont(EncryptableFonts.Helvetica);
  pdf.addPage([595, 842]).drawText("Protected content", { x: 50, y: 780, size: 14, font });
  pdf.encrypt({ userPassword, ownerPassword: `${userPassword}-owner` });
  return pdf.save();
}
