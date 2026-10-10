import * as vscode from "vscode";
import type {
  CursorTool,
  InitialView,
  PageColors,
  PanelId,
  PersistedViewState,
  ScrollModeName,
  SpreadModeName,
  ToolbarStyle,
  ViewerMode,
  ViewerSettings,
} from "./shared/protocol";

const SCALE_PATTERN = /^(\d+(?:\.\d+)?|auto|page-actual|page-fit|page-width)$/;

/**
 * Reads `pdfTools.default.<key>`; when the user has not set it anywhere, falls
 * back to vscode-pdf's `pdf-preview.default.<key>` (so switching from vscode-pdf
 * keeps the user's preferences), then to our default.
 */
function setting<T>(key: string, fallback: T, isValid: (value: unknown) => value is T, vscodePdfKey?: string): T {
  const ours = vscode.workspace.getConfiguration("pdfTools.default");
  const inspected = ours.inspect<T>(key);
  const explicit = inspected?.workspaceFolderValue ?? inspected?.workspaceValue ?? inspected?.globalValue;
  if (explicit !== undefined && isValid(explicit)) {
    return explicit;
  }
  if (vscodePdfKey) {
    const theirs = vscode.workspace.getConfiguration("pdf-preview.default").inspect<unknown>(vscodePdfKey);
    const value = theirs?.workspaceFolderValue ?? theirs?.workspaceValue ?? theirs?.globalValue;
    if (value !== undefined && isValid(value)) {
      return value;
    }
  }
  return fallback;
}

const oneOf =
  <T extends string>(...values: T[]) =>
  (value: unknown): value is T =>
    typeof value === "string" && (values as string[]).includes(value);
const isBoolean = (value: unknown): value is boolean => typeof value === "boolean";
const isScale = (value: unknown): value is string => typeof value === "string" && SCALE_PATTERN.test(value);

/** Settings that the open editors follow live (see `ViewerSettings`). */
export const LIVE_SETTINGS = ["pdfTools.toolbar", "pdfTools.pageColors"];

export function viewerSettings(): ViewerSettings {
  const config = vscode.workspace.getConfiguration("pdfTools");
  const toolbar = config.get<string>("toolbar");
  const pageColors = config.get<string>("pageColors");
  return {
    toolbar: oneOf<ToolbarStyle>("fixed", "floating")(toolbar) ? toolbar : "fixed",
    pageColors: oneOf<PageColors>("off", "theme")(pageColors) ? pageColors : "off",
  };
}

/** The view a document opens with: settings, then what was remembered for the file. */
export function initialView(remembered: PersistedViewState | undefined): InitialView {
  const defaults: InitialView = {
    mode: setting<ViewerMode | "auto">("mode", "auto", oneOf("auto", "view", "fill")),
    scale: setting("scale", "auto", isScale, "scale"),
    scrollMode: setting<ScrollModeName>("scrollMode", "vertical", oneOf("vertical", "horizontal", "wrapped", "page"), "scrollMode"),
    spreadMode: setting<SpreadModeName>("spreadMode", "none", oneOf("none", "odd", "even"), "spreadMode"),
    cursor: setting<CursorTool>("cursor", "select", oneOf("select", "hand"), "cursor"),
    sidebar: setting("sidebar", false, isBoolean, "sidebar"),
  };
  if (!remembered || !vscode.workspace.getConfiguration("pdfTools").get<boolean>("restoreViewState", true)) {
    return defaults;
  }
  return {
    ...defaults,
    mode: remembered.mode ?? defaults.mode,
    scale: isScale(remembered.scale) ? remembered.scale : defaults.scale,
    page: remembered.page,
    rotation: remembered.rotation,
    scrollMode: remembered.scrollMode,
    spreadMode: remembered.spreadMode,
    sidebar: remembered.sidebar,
    panel: remembered.panel as PanelId | undefined,
  };
}
