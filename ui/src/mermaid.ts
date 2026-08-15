/**
 * Preview-only Mermaid: ` ```mermaid ` / ` ```mmd `.
 * Source Markdown is never rewritten.
 */

export const MERMAID_LANGUAGES = new Set(["mermaid", "mmd"]);

export type MermaidRenderer = (id: string, source: string) => Promise<string>;

type MermaidApi = {
  initialize: (config: Record<string, unknown>) => void;
  render: (id: string, text: string) => Promise<{ svg: string }>;
};

let renderId = 0;
let loaded: Promise<MermaidApi> | null = null;

export function looksLikeMermaidFence(info: string): boolean {
  const lang = info.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  return MERMAID_LANGUAGES.has(lang);
}

export function mermaidFenceElements(root: ParentNode): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>("pre > code")).filter((code) => {
    if (!looksLikeMermaidFence(languageOf(code))) return false;
    if (code.closest(".plugin-code-block, .dv-block, .mermaid-block")) return false;
    return true;
  });
}

async function loadMermaid(): Promise<MermaidApi> {
  loaded ??= import("mermaid").then((mod) => {
    const mermaid = mod.default as MermaidApi;
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: "dark",
      fontFamily: "inherit",
    });
    return mermaid;
  });
  return loaded;
}

export async function hydrateMermaid(
  root: ParentNode,
  render?: MermaidRenderer,
): Promise<void> {
  const fences = mermaidFenceElements(root);
  if (fences.length === 0) return;

  const renderer = render ?? (async (id, source) => {
    const mermaid = await loadMermaid();
    const result = await mermaid.render(id, source);
    return result.svg;
  });

  for (const code of fences) {
    const pre = code.closest("pre");
    if (!pre?.parentNode) continue;
    const source = (code.textContent ?? "").trim();
    const figure = document.createElement("figure");
    figure.className = "mermaid-block";

    if (!source) {
      figure.classList.add("mermaid-empty");
      figure.innerHTML = `<code class="mermaid-empty">\`\`\`mermaid\`\`\`</code>`;
      pre.replaceWith(figure);
      continue;
    }

    try {
      const svg = await renderer(`nephrite-mermaid-${++renderId}`, source);
      figure.dataset.mermaidRendered = "1";
      figure.innerHTML = svg;
      const svgEl = figure.querySelector("svg");
      svgEl?.setAttribute("role", "img");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      figure.classList.add("mermaid-error");
      figure.innerHTML =
        `<figcaption class="mermaid-error-msg">${escapeHtml(message)}</figcaption>` +
        `<pre><code>${escapeHtml(source)}</code></pre>`;
    }
    pre.replaceWith(figure);
  }
}

function languageOf(code: HTMLElement): string {
  return (code.className.match(/language-(\S+)/)?.[1] ?? "").toLowerCase();
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
