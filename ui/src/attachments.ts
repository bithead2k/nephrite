import { invoke } from "@tauri-apps/api/core";
import { shortestWikilinkTarget } from "./wikilinks";

const IMAGE_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/bmp": "bmp",
};

export function isImageFile(file: File): boolean {
  return file.type.startsWith("image/") || /\.(?:png|jpe?g|gif|webp|svg|bmp)$/i.test(file.name);
}

export async function saveDroppedFiles(
  files: File[],
  fromPath: string,
): Promise<string[]> {
  const folder = await attachmentFolder(fromPath);
  const written: string[] = [];
  for (const file of files) {
    if (!isImageFile(file)) continue;
    const path = uniquePath(folder, fileNameFor(file));
    const data = await fileToBase64(file);
    await invoke("write_media_file", { path, data });
    written.push(path);
  }
  return written;
}

export function embedMarkdown(paths: string[], files: readonly { path: string }[] = []): string {
  return paths
    .map((path) => `![[${files.length ? shortestWikilinkTarget(path, [...files, { path }]) : path}]]`)
    .join("\n");
}

async function attachmentFolder(fromPath: string): Promise<string> {
  const noteDir = fromPath.includes("/") ? fromPath.slice(0, fromPath.lastIndexOf("/")) : "";
  try {
    const file = await invoke<{ content: string }>("read_file", { path: ".obsidian/app.json" });
    const parsed = JSON.parse(file.content) as { attachmentFolderPath?: string };
    const configured = parsed.attachmentFolderPath?.trim();
    if (!configured || configured === "./") return noteDir;
    if (configured.startsWith("./")) {
      return noteDir ? `${noteDir}/${configured.slice(2)}` : configured.slice(2);
    }
    return configured.replace(/^\/+/, "");
  } catch {
    return noteDir;
  }
}

function fileNameFor(file: File): string {
  const named = file.name.replace(/[/\\]/g, "").trim();
  if (named && named !== "image.png") return named;
  const ext = IMAGE_EXT[file.type] ?? "png";
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `Pasted image ${stamp}.${ext}`;
}

function uniquePath(folder: string, name: string): string {
  const base = folder ? `${folder}/${name}` : name;
  return base;
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Could not read image"));
    reader.onload = () => {
      const result = String(reader.result ?? "");
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.readAsDataURL(file);
  });
}
