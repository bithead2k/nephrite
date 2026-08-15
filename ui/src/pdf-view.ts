import { invoke } from "@tauri-apps/api/core";
import type { MediaFile } from "./types";
import { isPdfPath } from "./file-kinds";

type PdfModule = typeof import("pdfjs-dist");

let pdfjsPromise: Promise<PdfModule> | null = null;

async function loadPdfJs(): Promise<PdfModule> {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      const pdfjs = await import("pdfjs-dist");
      const worker = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
      pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
      return pdfjs;
    })();
  }
  return pdfjsPromise;
}

function bytesFromBase64(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export async function renderPdfView(host: HTMLElement, path: string): Promise<void> {
  host.replaceChildren();
  host.classList.add("pdf-viewer");
  const status = document.createElement("div");
  status.className = "feature-loading";
  status.textContent = `Loading ${path}…`;
  host.appendChild(status);
  try {
    const media = await invoke<MediaFile>("read_media_file", { path });
    const pdfjs = await loadPdfJs();
    const task = pdfjs.getDocument({ data: bytesFromBase64(media.data).slice() });
    const pdf = await task.promise;
    const pages = document.createElement("div");
    pages.className = "pdf-viewer-pages";
    host.replaceChildren(pages);
    for (let number = 1; number <= pdf.numPages; number++) {
      const page = await pdf.getPage(number);
      const viewport = page.getViewport({ scale: 1.2 });
      const canvas = document.createElement("canvas");
      canvas.className = "pdf-page";
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      canvas.setAttribute("aria-label", `${path} page ${number}`);
      const context = canvas.getContext("2d");
      if (!context) continue;
      await page.render({ canvasContext: context, viewport, canvas }).promise;
      pages.appendChild(canvas);
    }
  } catch (error) {
    host.replaceChildren();
    const failed = document.createElement("div");
    failed.className = "feature-error";
    failed.textContent = `Could not display PDF: ${String(error)}`;
    const open = document.createElement("button");
    open.type = "button";
    open.textContent = "Open with default app";
    open.addEventListener("click", () => void invoke("open_with_default_app", { path }));
    host.append(failed, open);
  }
}

export async function hydrateWikilinkPdf(
  link: HTMLAnchorElement,
  resolved: string,
  target: string,
): Promise<boolean> {
  if (!isPdfPath(resolved)) return false;
  const frame = document.createElement("div");
  frame.className = "pdf-embed";
  frame.dataset.pdfPath = resolved;
  frame.setAttribute("aria-label", target);
  link.replaceWith(frame);
  await renderPdfView(frame, resolved);
  return true;
}

export function clearPdfView(host: HTMLElement): void {
  host.replaceChildren();
}
