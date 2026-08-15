import { renderHighlightedSource } from "./syntax-highlight";

export function renderCodeView(host: HTMLElement, path: string, source: string): void {
  host.replaceChildren();
  host.classList.add("code-viewer");
  const header = document.createElement("div");
  header.className = "code-viewer-header";
  header.textContent = path;
  const body = document.createElement("div");
  body.className = "code-viewer-body";
  body.innerHTML = renderHighlightedSource(source, path);
  host.append(header, body);
}

export function clearCodeView(host: HTMLElement): void {
  host.replaceChildren();
}
