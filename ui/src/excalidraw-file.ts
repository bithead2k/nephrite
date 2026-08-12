import LZString from "lz-string";

type SceneElement = {
  id?: string;
  type?: string;
  text?: string;
  rawText?: string;
  originalText?: string;
  isDeleted?: boolean;
};

type Scene = {
  elements?: SceneElement[];
  [key: string]: unknown;
};

export type ExcalidrawDocument = {
  scene: string;
  format: "json" | "obsidian-json" | "obsidian-compressed";
  serialize: (scene: string) => string;
};

export function emptyExcalidrawFile(): string {
  return JSON.stringify({
    type: "excalidraw",
    version: 2,
    source: "nephrite",
    elements: [],
    appState: { gridSize: null, viewBackgroundColor: "#ffffff" },
    files: {},
  }, null, 2) + "\n";
}

const COMPRESSED_DRAWING = /(\r?\n##? Drawing\r?\n[^`]*```compressed-json\r?\n)([\s\S]*?)(```\r?\n)/m;
const JSON_DRAWING = /(\r?\n##? Drawing\r?\n[^`]*```json\r?\n)([\s\S]*?)(```\r?\n)/m;

export function isObsidianExcalidrawMarkdown(content: string): boolean {
  return /(?:^|\r?\n)excalidraw-plugin\s*:/m.test(content) ||
    COMPRESSED_DRAWING.test(content) || JSON_DRAWING.test(content);
}

export function parseExcalidrawDocument(path: string, content: string): ExcalidrawDocument {
  if (!path.toLowerCase().endsWith(".md")) {
    JSON.parse(content);
    return { scene: content, format: "json", serialize: (scene) => ensureNewline(scene) };
  }

  const compressed = content.match(COMPRESSED_DRAWING);
  if (compressed) {
    const scene = LZString.decompressFromBase64(compressed[2].replace(/[\r\n]/g, ""));
    if (!scene) throw new Error("The Obsidian Excalidraw payload could not be decompressed");
    const original = parseScene(scene);
    return {
      scene,
      format: "obsidian-compressed",
      serialize: (next) => {
        const synced = syncTextElements(content, original, parseScene(next));
        const payload = chunkBase64(LZString.compressToBase64(next), newlineOf(content));
        return synced.replace(COMPRESSED_DRAWING, (_all, open: string, _old: string, close: string) =>
          `${open}${payload}${newlineOf(content)}${close}`);
      },
    };
  }

  const json = content.match(JSON_DRAWING);
  if (json) {
    const scene = json[2].slice(0, json[2].lastIndexOf("}") + 1);
    const original = parseScene(scene);
    return {
      scene,
      format: "obsidian-json",
      serialize: (next) => syncTextElements(content, original, parseScene(next))
        .replace(JSON_DRAWING, (_all, open: string, _old: string, close: string) =>
          `${open}${next.trimEnd()}${newlineOf(content)}${close}`),
    };
  }

  throw new Error("This Markdown file is marked as Excalidraw, but has no Drawing JSON section");
}

function parseScene(scene: string): Scene {
  const parsed: unknown = JSON.parse(scene);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("The Excalidraw scene is not a JSON object");
  }
  return parsed as Scene;
}

function newlineOf(content: string): string {
  return content.includes("\r\n") ? "\r\n" : "\n";
}

function ensureNewline(content: string): string {
  return content.endsWith("\n") ? content : `${content}\n`;
}

function chunkBase64(content: string, newline: string): string {
  const chunks: string[] = [];
  for (let index = 0; index < content.length; index += 256) {
    chunks.push(content.slice(index, index + 256));
  }
  return chunks.join(`${newline}${newline}`);
}

/**
 * Obsidian gives its editable Text Elements section priority over scene JSON.
 * Preserve unchanged raw blocks (including links), updating only text elements
 * that the drawing editor actually changed, added, or removed.
 */
function syncTextElements(document: string, original: Scene, next: Scene): string {
  const section = /(^|\r?\n)(##? Text Elements\r?\n)([\s\S]*?)(?=\r?\n(?:##? (?:Element Links|Embedded Files|Drawing)\r?\n|%%\r?\n##? Drawing\r?\n))/m;
  const match = document.match(section);
  if (!match) return document;
  const newline = newlineOf(document);
  const oldElements = new Map((original.elements ?? []).filter((item) => item.id).map((item) => [item.id!, item]));
  const rawBlocks = new Map<string, string>();
  const blockPattern = /([\s\S]*?) \^([A-Za-z0-9_-]+)\r?\n(?:\r?\n|$)/g;
  for (const block of match[3].matchAll(blockPattern)) rawBlocks.set(block[2], block[0]);

  let body = "";
  for (const element of next.elements ?? []) {
    if (element.type !== "text" || element.isDeleted || !element.id) continue;
    const previous = oldElements.get(element.id);
    const oldText = previous?.rawText ?? previous?.originalText ?? previous?.text ?? "";
    const newText = element.rawText ?? element.originalText ?? element.text ?? "";
    const preserved = oldText === newText ? rawBlocks.get(element.id) : null;
    body += preserved ?? `${newText} ^${element.id}${newline}${newline}`;
  }
  return document.replace(section, (_all, before: string, heading: string) =>
    `${before}${heading}${body}`);
}
