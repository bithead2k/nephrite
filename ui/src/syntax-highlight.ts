import hljs from "highlight.js/lib/common";
import pgsql from "highlight.js/lib/languages/pgsql";
import { languageFromClass, languageFromPath } from "./file-kinds";

hljs.registerLanguage("pgsql", pgsql);

const SKIP_LANGUAGES = new Set([
  "dataview",
  "dataviewjs",
  "query",
  "templater",
  "math",
  "tex",
  "mermaid",
  "mmd",
  "csv",
  "base",
  "bases",
]);

/** Fenced languages owned by the query/script engine — not highlight.js. */
const ENGINE_FENCE_LANGUAGES = new Set([
  "dataview",
  "dataviewjs",
  "js",
  "javascript",
  "nephrite",
  "nephritejs",
  "pgsql",
]);

/** Fence tags vaults already use that highlight.js names differently. */
const LANGUAGE_ALIASES: Record<string, string> = {
  sqlpostgresql: "pgsql",
  postgresql: "pgsql",
  postgres: "pgsql",
  psql: "pgsql",
  plpgsql: "pgsql",
};

export function resolveHighlightLanguage(language: string): string {
  const lang = language.toLowerCase();
  return LANGUAGE_ALIASES[lang] ?? lang;
}

export function highlightSource(source: string, language: string): string {
  const lang = resolveHighlightLanguage(language);
  if (!lang || lang === "plaintext" || lang === "text" || lang === "plain") {
    return escapeHtml(source);
  }
  try {
    if (hljs.getLanguage(lang)) {
      return hljs.highlight(source, { language: lang, ignoreIllegals: true }).value;
    }
  } catch {
    /* fall through */
  }
  try {
    return hljs.highlightAuto(source).value;
  } catch {
    return escapeHtml(source);
  }
}

export function highlightPreviewCode(root: ParentNode): void {
  for (const code of Array.from(root.querySelectorAll<HTMLElement>("code"))) {
    if (code.dataset.highlighted === "1") continue;
    if (code.closest(".plugin-code-block, .dv-block, .dv-inline")) continue;
    const declared = languageFromClass(code.className);
    if (!declared || SKIP_LANGUAGES.has(declared)) continue;
    if (code.closest("pre") && ENGINE_FENCE_LANGUAGES.has(declared)) continue;
    const source = code.textContent ?? "";
    if (!source.trim()) continue;
    const language = resolveHighlightLanguage(declared);
    code.innerHTML = highlightSource(source, language);
    code.classList.add("hljs");
    code.classList.add(`language-${declared}`);
    code.dataset.highlighted = "1";
  }
}

export function renderHighlightedSource(source: string, path: string): string {
  const language = languageFromPath(path);
  return `<pre class="code-viewer-pre"><code class="hljs language-${language}">${highlightSource(source, language)}</code></pre>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
