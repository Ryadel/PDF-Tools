import type { AppContext } from "../../app/context";
import { t } from "../../l10n";
import { h } from "../dom";
import { icon } from "../icons";
import type { Panel } from "../sidebar";

/** Base for panels that load once per document and render static content. */
abstract class LoadOncePanel implements Panel {
  abstract readonly id: Panel["id"];
  abstract readonly title: string;
  abstract readonly action: Panel["action"];
  readonly element = h("div", { class: "static-panel" });
  #loadStarted = false;

  constructor(protected readonly app: AppContext) {}

  reset(): void {
    this.#loadStarted = false;
    this.element.replaceChildren();
  }

  show(): void {
    if (this.#loadStarted) {
      return;
    }
    this.#loadStarted = true;
    void this.load().catch((error: unknown) => {
      this.element.replaceChildren(h("div", { class: "empty", text: t("Cannot read this information: {0}", error instanceof Error ? error.message : String(error)) }));
    });
  }

  protected abstract load(): Promise<void>;
}

export class AttachmentsPanel extends LoadOncePanel {
  readonly id = "attachments";
  readonly title = t("Attachments");
  readonly action = "showAttachments";

  protected async load(): Promise<void> {
    const attachments = await this.app.engine.getAttachments();
    if (attachments.length === 0) {
      this.element.replaceChildren(h("div", { class: "empty", text: t("This PDF has no attachments.") }));
      return;
    }
    this.element.replaceChildren(
      ...attachments.map((attachment) =>
        h(
          "div",
          { class: "attachment-row", title: attachment.description ?? attachment.filename },
          icon("codicon:file"),
          h("span", { class: "attachment-name", text: attachment.filename }),
          h(
            "button",
            {
              class: "icon",
              title: t("Open in VS Code"),
              attrs: { type: "button", "aria-label": t("Open {0}", attachment.filename) },
              on: { click: () => this.app.post({ type: "openAttachment", filename: attachment.filename, data: attachment.data.slice() }) },
            },
            icon("codicon:go-to-file"),
          ),
          h(
            "button",
            {
              class: "icon",
              title: t("Save As…"),
              attrs: { type: "button", "aria-label": t("Save {0}", attachment.filename) },
              on: { click: () => this.app.post({ type: "saveAttachment", filename: attachment.filename, data: attachment.data.slice() }) },
            },
            icon("codicon:save"),
          ),
        ),
      ),
    );
  }
}

export class LayersPanel extends LoadOncePanel {
  readonly id = "layers";
  readonly title = t("Layers");
  readonly action = "showLayers";

  protected async load(): Promise<void> {
    const layers = await this.app.engine.getLayers();
    if (layers.length === 0) {
      this.element.replaceChildren(h("div", { class: "empty", text: t("This PDF has no layers.") }));
      return;
    }
    this.element.replaceChildren(
      ...layers.map((layer) => {
        const checkbox = h("input", {
          attrs: { type: "checkbox", checked: layer.visible },
          on: { change: () => void this.app.engine.setLayerVisible(layer.id, checkbox.checked) },
        });
        const row = h("label", { class: "layer-row" }, checkbox, h("span", { text: layer.name }));
        row.style.paddingLeft = `${layer.depth * 14 + 4}px`;
        return row;
      }),
    );
  }
}

export class PropertiesPanel extends LoadOncePanel {
  readonly id = "properties";
  readonly title = t("Document Properties");
  readonly action = "showProperties";

  protected async load(): Promise<void> {
    const { fields } = await this.app.engine.getProperties();
    const fonts = h("div", { class: "fonts" });
    const listFonts = h("button", {
      class: "text-button",
      text: t("List Fonts"),
      title: t("Reads every page to find the fonts it uses"),
      attrs: { type: "button" },
      on: { click: () => void this.#listFonts(fonts) },
    });
    fonts.append(listFonts);
    this.element.replaceChildren(
      h("dl", { class: "properties" }, ...fields.flatMap(([label, value]) => [h("dt", { text: label }), h("dd", { text: value })])),
      h("h3", { class: "properties-heading", text: t("Fonts") }),
      fonts,
    );
  }

  async #listFonts(target: HTMLElement): Promise<void> {
    const progress = h("div", { class: "empty", text: t("Reading the pages…") });
    target.replaceChildren(progress);
    try {
      const fonts = await this.app.engine.getFonts((page, count) => {
        progress.textContent = t("Reading page {0} of {1}…", page, count);
      });
      if (fonts.length === 0) {
        target.replaceChildren(h("div", { class: "empty", text: t("No fonts: the pages contain no text, or only images of text.") }));
        return;
      }
      const notEmbedded = fonts.filter((font) => !font.embedded).length;
      target.replaceChildren(
        h("div", {
          class: "search-summary",
          text: `${fonts.length === 1 ? t("1 font") : t("{0} fonts", fonts.length)}, ${notEmbedded ? t("{0} not embedded", notEmbedded) : t("all embedded")}`,
        }),
        ...fonts.map((font) =>
          h(
            "div",
            { class: "font-row", title: font.embedded ? "" : t("Not embedded: other viewers and printers substitute a similar font") },
            h("span", { class: "font-name", text: font.name }),
            h("span", {
              class: "font-details",
              text: [font.type, font.embedded ? (font.subset ? t("embedded subset") : t("embedded")) : t("not embedded")].filter(Boolean).join(" · "),
            }),
          ),
        ),
      );
    } catch (error) {
      target.replaceChildren(h("div", { class: "empty", text: t("Cannot read the fonts: {0}", error instanceof Error ? error.message : String(error)) }));
    }
  }
}
