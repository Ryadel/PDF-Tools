# Changelog

All notable changes to PDF Tools are documented in this file. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.0.1] - 2026-10-12

### Fixed

- Form values changed while a save was in progress were left out of editors opened afterwards, and the document could end up marked as saved without them. Overlapping saves now run one after the other.
- Running **Open Text in Editor** again replaced the text of an extraction you had edited; it now opens a new editor (`<name> (2).txt`), or shows the existing one if unchanged.
- Temporary copies of opened attachments were never deleted; like print copies, they are now deleted after a day.
- The README listed split and merge, which are not available yet.

## [1.0.0] - 2026-10-10

First release on the Visual Studio Marketplace, with everything listed below for 1.0.0, 0.2.0 and 0.1.0. Versions 0.1.0 and 0.2.0 were internal builds and were not published; 1.0.0 was developed as 0.3.0.

### Added

- **Save** button in the toolbar, enabled when the document has unsaved changes; **Save** and **Save As…** in the "…" menu.
- **Focus mode**: a floating toolbar that hides when the mouse is still (`pdfTools.toolbar: floating`, or *Toggle Focus Mode* for one editor).
- **Presentation mode** (Ctrl+Alt+P): one fitted page at a time, full screen through VS Code's Zen mode; arrow keys, Space, mouse wheel or click change page, Escape ends it and restores the view.
- **Match Theme Colors**: pages drawn in the theme's editor background and foreground, keeping hues (`pdfTools.pageColors: theme`, or *Toggle Theme Colors for Pages*).
- **Open Text in Editor**: the text of all pages in an untitled editor, with page markers.
- **Copy Page as Image** and **Export Page as PNG…** (2× resolution, form values included).
- **Copy Link to This Page**: a `vscode://ryadel.pdf-tools/open?page=…&file=…` link that opens the PDF at that page.
- **Print Pages…**: print the current page or a range (`1-3, 7, 10-`), form values included.
- **Export / Import Form Data…** as JSON or XFDF.
- **Fonts** in Document Properties (name, type, embedded or not, subset), listed on demand.
- The "…" menu has two columns (one in narrow editors) and opens upwards from the floating toolbar.
- **Italian, French and German** translations of the whole interface, the commands and the settings (following VS Code's display language).

### Fixed

- Automatic zoom, Fit Page and Fit to Width did not re-fit when the editor or the sidebar changed size.
- Search results joined the last word of a line and the first of the next ("andgovernment").
- A search started right after a PDF opened or reloaded (for example with the find widget open during *Revert File*) could stay at "Searching…" forever.
- The `pdfTools.default.scale` setting rejected numeric scales such as `1.5` (broken validation pattern).

## [0.2.0] - 2026-10-10 (not published)

### Added

- New UI: two-row toolbar (fixed navigation row + tools of the current mode), **View** and **Fill** modes, "…" menu, activity strip and sidebar, status bar items (page, zoom, form state).
- Sidebar panels: Pages (thumbnails), Outline (filter, find current item), Search, Form Fields, Attachments (open or save), Layers, Document Properties (with encryption and permissions).
- Find widget (Ctrl+F, F3): match case, whole word, match diacritics (off by default: *onesta* finds *onestà*), highlight all, result count.
- Search panel (Ctrl+Shift+F): every match with its context, grouped by page; click to select it.
- Navigation: first/last page, Go to Page (Ctrl+G, page labels), back/forward history (Alt+←/→), page labels in the toolbar and status bar.
- View: rotation, scrolling modes (vertical, horizontal, wrapped, single page), spreads, actual size, Ctrl+wheel and pinch zoom, hand tool.
- Fill mode: opens automatically for PDFs with form fields; field highlighting, next/previous field, next required empty field, Clear Form.
- Remembered view per file; `pdfTools.default.*` settings with fallback to vscode-pdf's `pdf-preview.default.*`.
- Password-protected PDFs (password asked by VS Code).
- 45 commands in the Command Palette, keyboard shortcuts.

### Fixed

- Print buttons showed no icon (Codicons has no print icon).
- On PDFs with forms, the form fields were drawn over the "…" menu and the find widget.

### Changed

- The editor is now called **PDF Viewer** (was *PDF Preview*), so it is easy to tell apart from vscode-pdf's *Pdf Preview* when VS Code asks which editor to use.

## [0.1.0] - 2026-10-09 (not published)

### Added

- Editable custom editor for `*.pdf` files, based on PDF.js 6.4.
- Form filling (AcroForm text fields, checkboxes, radio buttons, drop-down lists, list boxes).
- Save, Save As, Revert, auto save and hot exit (backup and restore of unsaved form values). Saves are incremental updates of the original file.
- Toolbar with page navigation, zoom, fit to width and print, following the VS Code theme.
- Print through the system PDF application (`pdfTools.print.method`), including unsaved form values.
- Live sync of form values between several editors of the same file.
- Automatic reload when the file changes on disk and has no unsaved changes; prompt otherwise.
- Warning for XFA forms, which are not supported.
