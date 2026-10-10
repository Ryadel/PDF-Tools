import type { FormDataFormat } from "../../src/shared/protocol";
import { t } from "../l10n";

/**
 * Form data files: JSON (our own, simple) and XFDF (Adobe's XML format, read
 * and written by Acrobat and most PDF tools). Field names are fully qualified
 * (`parent.child`); values are engine-neutral.
 */

/** A field's value: text, checked state, the selected option(s), or none. */
export type FormValue = string | boolean | string[] | null;

export interface FormFieldValue {
  name: string;
  type: "text" | "checkbox" | "radio" | "choice";
  value: FormValue;
  /** Checkbox: the value XFDF stores when checked (usually "Yes"). */
  onValue?: string;
}

export const JSON_FORMAT = "pdf-tools-form-data";
const XFDF_NAMESPACE = "http://ns.adobe.com/xfdf/";
/** XFDF's value for an unchecked checkbox or a radio group with no selection. */
const OFF = "Off";

export function serializeFormData(format: FormDataFormat, fields: FormFieldValue[], fileName: string): string {
  return format === "xfdf" ? toXfdf(fields, fileName) : toJson(fields, fileName);
}

/** Values by field name. Throws with a readable message if the file cannot be read. */
export function parseFormData(format: FormDataFormat, text: string): Map<string, FormValue> {
  return format === "xfdf" ? parseXfdf(text) : parseJson(text);
}

export function toJson(fields: FormFieldValue[], fileName: string): string {
  const values: Record<string, FormValue> = {};
  for (const field of fields) {
    values[field.name] = field.value;
  }
  return `${JSON.stringify({ format: JSON_FORMAT, version: 1, source: fileName, fields: values }, null, 2)}\n`;
}

/**
 * Accepts our format (`{ format, version, fields: {…} }`) or a plain object of
 * `name: value` pairs, so hand-written files work too.
 */
export function parseJson(text: string): Map<string, FormValue> {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new Error(t("The file is not valid JSON ({0}).", error instanceof Error ? error.message : String(error)), { cause: error });
  }
  if (!isRecord(data)) {
    throw new Error(t("The file does not contain form data (expected a JSON object)."));
  }
  const fields = isRecord(data.fields) ? data.fields : data;
  const values = new Map<string, FormValue>();
  for (const [name, value] of Object.entries(fields)) {
    if (fields === data && (name === "format" || name === "version" || name === "source")) {
      continue;
    }
    if (typeof value === "string" || typeof value === "boolean" || value === null) {
      values.set(name, value);
    } else if (typeof value === "number") {
      values.set(name, String(value));
    } else if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
      values.set(name, value);
    }
  }
  return values;
}

export function toXfdf(fields: FormFieldValue[], fileName: string): string {
  // XFDF nests fields by name part: "a.b" is <field name="a"><field name="b">.
  interface Node {
    children: Map<string, Node>;
    values?: string[];
  }
  const root: Node = { children: new Map() };
  for (const field of fields) {
    let node = root;
    for (const part of field.name.split(".")) {
      let child = node.children.get(part);
      if (!child) {
        child = { children: new Map() };
        node.children.set(part, child);
      }
      node = child;
    }
    node.values = xfdfValues(field);
  }
  const lines: string[] = [];
  const write = (node: Node, indent: string) => {
    for (const [name, child] of node.children) {
      lines.push(`${indent}<field name="${escapeXml(name)}">`);
      for (const value of child.values ?? []) {
        lines.push(`${indent}  <value>${escapeXml(value)}</value>`);
      }
      write(child, `${indent}  `);
      lines.push(`${indent}</field>`);
    }
  };
  write(root, "    ");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<xfdf xmlns="${XFDF_NAMESPACE}" xml:space="preserve">`,
    `  <f href="${escapeXml(fileName)}"/>`,
    "  <fields>",
    ...lines,
    "  </fields>",
    "</xfdf>",
    "",
  ].join("\n");
}

function xfdfValues(field: FormFieldValue): string[] {
  const { value } = field;
  if (Array.isArray(value)) {
    return value;
  }
  if (typeof value === "boolean") {
    return [value ? (field.onValue ?? "Yes") : OFF];
  }
  if (value === null) {
    return field.type === "checkbox" || field.type === "radio" ? [OFF] : [""];
  }
  return [value];
}

/** Reads `<fields>` of an XFDF document (flat or nested field names). */
export function parseXfdf(text: string): Map<string, FormValue> {
  const xml = new DOMParser().parseFromString(text, "application/xml");
  if (xml.getElementsByTagName("parsererror").length > 0 || xml.documentElement.localName !== "xfdf") {
    throw new Error(t("The file is not a valid XFDF document."));
  }
  const values = new Map<string, FormValue>();
  const childrenNamed = (element: Element, name: string) => [...element.children].filter((child) => child.localName === name);
  const visit = (field: Element, prefix: string) => {
    const name = prefix + (field.getAttribute("name") ?? "");
    const fieldValues = childrenNamed(field, "value").map((value) => value.textContent ?? "");
    if (fieldValues.length === 1) {
      values.set(name, fieldValues[0]);
    } else if (fieldValues.length > 1) {
      values.set(name, fieldValues);
    }
    for (const child of childrenNamed(field, "field")) {
      visit(child, `${name}.`);
    }
  };
  for (const fieldsElement of childrenNamed(xml.documentElement, "fields")) {
    for (const field of childrenNamed(fieldsElement, "field")) {
      visit(field, "");
    }
  }
  return values;
}

/** XFDF's "Off" means unchecked / no selection, whatever the field. */
export function isOff(value: FormValue): boolean {
  return value === null || value === false || value === OFF;
}

function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
