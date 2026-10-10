/**
 * Starts the PDF.js worker from a Blob URL.
 *
 * Webview resources are served from a different origin than the webview
 * document, so `new Worker(resourceUrl)` is rejected. Fetching the script and
 * starting it from a same-origin Blob URL works (CSP: `worker-src blob:`).
 */
export async function startPdfjsWorker(workerUrl: string): Promise<Worker> {
  const response = await fetch(workerUrl);
  if (!response.ok) {
    throw new Error(`Cannot load the PDF.js worker (${response.status} ${response.statusText}).`);
  }
  const source = await response.blob();
  const blobUrl = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
  return new Worker(blobUrl, { type: "module", name: "pdf.js worker" });
}
