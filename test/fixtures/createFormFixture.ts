import { PDFDocument, StandardFonts } from "pdf-lib";

/** Field names of the synthetic form; one has an accented name on purpose. */
export const FIELDS = {
  name: "Nome",
  accentedName: "GradoSensibilità",
  notes: "Note",
  agree: "Accetto",
  clan: "Clan",
  school: "Scuola",
} as const;

export const CLAN_OPTIONS = ["Rosso", "Verde", "Blu"];
export const SCHOOL_OPTIONS = ["Nord", "Centro", "Sud"];

/**
 * Builds a one-page AcroForm PDF with text fields (single and multi-line),
 * a checkbox, a radio group and a dropdown, using the non-embedded Helvetica
 * standard font like most real-world forms.
 */
export async function createFormFixture(initial: { name?: string } = {}): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([595, 842]);
  const form = pdf.getForm();

  let y = 760;
  const label = (text: string) => {
    page.drawText(text, { x: 50, y: y + 6, size: 11, font });
  };
  const nextRow = (height = 24) => {
    y -= height + 16;
  };

  label("Nome");
  const name = form.createTextField(FIELDS.name);
  name.addToPage(page, { x: 200, y, width: 300, height: 24, font });
  if (initial.name) {
    name.setText(initial.name);
  }
  nextRow();

  label("Grado di sensibilità");
  form.createTextField(FIELDS.accentedName).addToPage(page, { x: 200, y, width: 300, height: 24, font });
  nextRow();

  label("Note");
  y -= 40;
  const notes = form.createTextField(FIELDS.notes);
  notes.enableMultiline();
  notes.addToPage(page, { x: 200, y, width: 300, height: 64, font });
  nextRow();

  label("Accetto");
  form.createCheckBox(FIELDS.agree).addToPage(page, { x: 200, y, width: 18, height: 18 });
  nextRow();

  label("Clan");
  const clan = form.createRadioGroup(FIELDS.clan);
  CLAN_OPTIONS.forEach((option, index) => {
    clan.addOptionToPage(option, page, { x: 200 + index * 90, y, width: 18, height: 18 });
    page.drawText(option, { x: 224 + index * 90, y: y + 4, size: 11, font });
  });
  nextRow();

  label("Scuola");
  const school = form.createDropdown(FIELDS.school);
  school.addOptions(SCHOOL_OPTIONS);
  school.addToPage(page, { x: 200, y, width: 300, height: 24, font });

  form.updateFieldAppearances(font);
  return pdf.save();
}
