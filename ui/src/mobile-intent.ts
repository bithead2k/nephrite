export type MobileIntent =
  | { kind: "daily" }
  | { kind: "open"; path: string }
  | { kind: "capture"; text: string; title: string; location: string };

export function parseMobileIntent(raw: string): MobileIntent | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "nephrite:") return null;
  const action = url.hostname || url.pathname.replace(/^\/+/, "");
  if (action === "daily") return { kind: "daily" };
  if (action === "open") {
    const path = url.searchParams.get("path")?.trim() ?? "";
    return path ? { kind: "open", path } : null;
  }
  if (action === "capture") {
    return {
      kind: "capture",
      text: url.searchParams.get("text") ?? "",
      title: url.searchParams.get("title") ?? "",
      location: url.searchParams.get("location") ?? "Inbox",
    };
  }
  return null;
}

export function captureNotePath(location: string, title: string, now = new Date()): string {
  const folder = location.replace(/\\/g, "/").split("/")
    .filter((part) => part && part !== "." && part !== "..")
    .map(safePathPart)
    .filter(Boolean)
    .join("/");
  const fallback = `Capture ${localTimestamp(now)}`;
  const expanded = expandCaptureVariables(title.trim() || fallback, now).replace(/\.md$/i, "");
  const name = safePathPart(expanded) || fallback;
  return `${folder ? `${folder}/` : ""}${name}.md`;
}

export function expandCaptureVariables(value: string, now = new Date()): string {
  const date = localDate(now);
  const time = [now.getHours(), now.getMinutes(), now.getSeconds()].map((part) => String(part).padStart(2, "0")).join("-");
  return value.replace(/\{date\}/gi, date).replace(/\{time\}/gi, time);
}

function safePathPart(value: string): string {
  return value.replace(/[\u0000-\u001f<>:"|?*]/g, "-").replace(/^\.+|\.+$/g, "").trim();
}

function localDate(date: Date): string {
  return [date.getFullYear(), date.getMonth() + 1, date.getDate()].map((part, index) => index ? String(part).padStart(2, "0") : String(part)).join("-");
}

function localTimestamp(date: Date): string {
  return `${localDate(date)} ${[date.getHours(), date.getMinutes(), date.getSeconds()].map((part) => String(part).padStart(2, "0")).join("-")}`;
}
