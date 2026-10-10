import type { HostToWebview, WebviewConfig } from "../src/shared/protocol";
import { App } from "./app/app";
import { watchForProblems } from "./diagnostics";
import { PdfjsEngine } from "./engine/pdfjs/pdfjsEngine";
import { t } from "./l10n";
import { Banner } from "./ui/banner";
import { host, hostLog } from "./vscodeApi";

watchForProblems();

async function main(): Promise<void> {
  const config = JSON.parse(document.body.dataset.config ?? "{}") as WebviewConfig;
  const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const container = element<HTMLDivElement>("viewerContainer");

  // The worker must be running before the engine (and the App) can be created.
  const engine = await PdfjsEngine.create(config, container, {
    onModified: () => app.onModified(),
    onFieldChanges: (changes) => app.onFieldChanges(changes),
    onViewChange: () => app.onViewChange(),
    onFindChange: (state) => app.onFindChange(state),
    onFormRendered: () => app.onFieldsChanged(),
  });
  const app = new App(
    (message) => host.postMessage(message),
    {
      row1: element("toolbar"),
      row2: element("toolbar2"),
      strip: element("strip"),
      sidebar: element("sidebar"),
      canvasArea: element("canvasArea"),
      container,
    },
    () => engine,
  );

  // Development harness only (tools/webview-preview): never set in VS Code.
  if (document.body.dataset.debug !== undefined) {
    Object.assign(window, { pdfToolsApp: app, pdfToolsEngine: engine });
  }

  // Messages are handled one at a time, in order: a save must not overlap a load.
  let queue = Promise.resolve();
  window.addEventListener("message", (event: MessageEvent<HostToWebview>) => {
    const message = event.data;
    // A password answer must not wait behind the load that is asking for it.
    if (message.type === "password") {
      void app.handleMessage(message);
      return;
    }
    queue = queue
      .then(() => app.handleMessage(message))
      .catch((error: unknown) => {
        hostLog("error", `Failed to handle "${message.type}": ${describe(error)}`);
      });
  });

  host.postMessage({ type: "ready" });
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

main().catch((error: unknown) => {
  const message = t("PDF Tools failed to start: {0}", describe(error));
  new Banner().show("error", message);
  host.postMessage({ type: "loadError", message });
});
