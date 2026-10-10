// Exports media/icon.svg to media/icon.png (256 × 256, transparent corners) with
// headless Microsoft Edge over the DevTools protocol (Node's global WebSocket).
// Run after changing the SVG: node scripts/export-icon.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SIZE = 256;
const EDGE = process.env.EDGE_PATH ?? "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const root = resolve(import.meta.dirname, "..");
const svg = readFileSync(join(root, "media", "icon.svg"), "utf8");
const out = join(root, "media", "icon.png");

const profile = mkdtempSync(join(tmpdir(), "pdf-tools-icon-"));
const port = 9900 + Math.floor(Math.random() * 90);
const browser = spawn(EDGE, ["--headless=new", "--disable-gpu", "--hide-scrollbars", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "about:blank"], {
  stdio: "ignore",
});
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
try {
  let version;
  for (let i = 0; i < 100 && !version; i++) {
    try {
      version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    } catch {
      await sleep(200);
    }
  }
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((done) => ws.addEventListener("open", done));
  let nextId = 0;
  const pending = new Map();
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    pending.get(message.id)?.(message);
  });
  const send = (method, params = {}, sessionId) =>
    new Promise((done) => {
      const id = ++nextId;
      pending.set(id, done);
      ws.send(JSON.stringify({ id, method, params, sessionId }));
    });

  const { result: { targetId } } = await send("Target.createTarget", { url: "about:blank" });
  const { result: { sessionId } } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Emulation.setDeviceMetricsOverride", { width: SIZE, height: SIZE, deviceScaleFactor: 1, mobile: false }, sessionId);
  await send("Emulation.setDefaultBackgroundColorOverride", { color: { r: 0, g: 0, b: 0, a: 0 } }, sessionId);
  const style = "<style>html,body{margin:0;overflow:hidden;background:transparent}svg{display:block}</style>";
  const html = `<!DOCTYPE html><html><head>${style}</head><body>${svg.replace(/width="128" height="128"/, `width="${SIZE}" height="${SIZE}"`)}</body></html>`;
  await send("Page.navigate", { url: `data:text/html;base64,${Buffer.from(html).toString("base64")}` }, sessionId);
  await sleep(1_000);
  const shot = await send("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: SIZE, height: SIZE, scale: 1 } }, sessionId);
  writeFileSync(out, Buffer.from(shot.result.data, "base64"));
  await send("Browser.close");
  ws.close();
  console.log(`${out}: ${SIZE} × ${SIZE}`);
} finally {
  browser.kill();
  await sleep(300);
  rmSync(profile, { recursive: true, force: true });
}
