/** Extension helpers for in-app viewers. Index `file_kind` stays coarse. */

const CODE_EXTENSIONS: Record<string, string> = {
  rs: "rust",
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  go: "go",
  json: "json",
  yml: "yaml",
  yaml: "yaml",
  toml: "ini",
  css: "css",
  scss: "scss",
  less: "less",
  html: "xml",
  htm: "xml",
  xml: "xml",
  svg: "xml",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  sql: "sql",
  pgsql: "pgsql",
  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  rb: "ruby",
  php: "php",
  lua: "lua",
  swift: "swift",
  cs: "csharp",
  r: "r",
  dockerfile: "dockerfile",
  makefile: "makefile",
  mk: "makefile",
  ini: "ini",
  cfg: "ini",
  conf: "ini",
  env: "ini",
  txt: "plaintext",
  log: "plaintext",
  diff: "diff",
  patch: "diff",
  graphql: "graphql",
  md: "markdown",
};

export function fileExtension(path: string): string {
  const name = path.replace(/^.*\//, "");
  if (/^Dockerfile$/i.test(name)) return "dockerfile";
  if (/^Makefile$/i.test(name)) return "makefile";
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export function isPdfPath(path: string): boolean {
  return fileExtension(path) === "pdf";
}

export function isAudioPath(path: string): boolean {
  return ["mp3", "wav", "ogg", "m4a", "aac", "flac", "oga"].includes(fileExtension(path));
}

export function isVideoPath(path: string): boolean {
  return ["mp4", "webm", "ogv", "mov", "m4v"].includes(fileExtension(path));
}

export function isImagePath(path: string): boolean {
  return ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico"].includes(fileExtension(path));
}

export function isCsvPath(path: string): boolean {
  return fileExtension(path) === "csv";
}

export function isStructuredPath(path: string): boolean {
  return ["json", "yml", "yaml"].includes(fileExtension(path));
}

export function isBasePath(path: string): boolean {
  return fileExtension(path) === "base";
}

export function isCodePath(path: string): boolean {
  const ext = fileExtension(path);
  if (!ext || ext === "md" || ext === "markdown") return false;
  if (isCsvPath(path) || isStructuredPath(path)) return false;
  return ext in CODE_EXTENSIONS;
}

export function languageFromPath(path: string): string {
  return CODE_EXTENSIONS[fileExtension(path)] ?? "plaintext";
}

export function languageFromClass(className: string): string | null {
  const match = className.match(/(?:^|\s)language-([A-Za-z0-9_+-]+)/);
  return match ? match[1].toLowerCase() : null;
}
