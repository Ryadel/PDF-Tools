import { readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Print copies: one file per print. */
export const PRINT_TEMP_FOLDER = join(tmpdir(), "vscode-pdf-tools-print");
/** Opened attachments: one subfolder per opening, so the original file name is kept. */
export const ATTACHMENT_TEMP_FOLDER = join(tmpdir(), "vscode-pdf-tools-attachments");
/** Temporary copies older than this are deleted on the next print, attachment opening or activation. */
const TEMP_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Best-effort cleanup of temporary copies left by earlier prints and attachment openings. */
export async function deleteOldTempFiles(): Promise<void> {
  const now = Date.now();
  for (const folder of [PRINT_TEMP_FOLDER, ATTACHMENT_TEMP_FOLDER]) {
    let entries: string[];
    try {
      entries = await readdir(folder);
    } catch {
      continue; // Folder missing.
    }
    for (const entry of entries) {
      const path = join(folder, entry);
      try {
        if (now - (await stat(path)).mtimeMs > TEMP_MAX_AGE_MS) {
          await rm(path, { recursive: true, force: true });
        }
      } catch {
        // File in use: try again next time.
      }
    }
  }
}
