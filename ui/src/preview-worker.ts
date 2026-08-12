import { renderPreview } from "./preview";

type PreviewRequest = {
  id: number;
  markdown: string;
};

type PreviewResponse = {
  id: number;
  html: string;
  renderMs: number;
};

self.addEventListener("message", (event: MessageEvent<PreviewRequest>) => {
  const started = performance.now();
  const response: PreviewResponse = {
    id: event.data.id,
    html: renderPreview(event.data.markdown),
    renderMs: performance.now() - started,
  };
  self.postMessage(response);
});
