import type { AttachmentRow } from "./types";

export type AttachmentFilters = {
  query: string;
  kind: "all" | "image" | "audio" | "video" | "document" | "other";
  orphanedOnly: boolean;
  sort: "path" | "size" | "references";
};

export const DEFAULT_ATTACHMENT_FILTERS: AttachmentFilters = {
  query: "",
  kind: "all",
  orphanedOnly: false,
  sort: "path",
};

export function attachmentCategory(mime: string): AttachmentFilters["kind"] {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("text/") || mime === "application/pdf" ||
      mime.includes("document") || mime.includes("spreadsheet") || mime.includes("presentation")) {
    return "document";
  }
  return "other";
}

export function selectAttachments(
  rows: readonly AttachmentRow[],
  filters: AttachmentFilters,
): AttachmentRow[] {
  const query = filters.query.trim().toLowerCase();
  const selected = rows.filter((row) =>
    (!filters.orphanedOnly || row.orphaned) &&
    (filters.kind === "all" || attachmentCategory(row.mime_type) === filters.kind) &&
    (!query || `${row.path} ${row.mime_type}`.toLowerCase().includes(query))
  );
  return selected.sort((left, right) => {
    if (filters.sort === "size") return right.size_bytes - left.size_bytes || left.path.localeCompare(right.path);
    if (filters.sort === "references") return right.reference_count - left.reference_count || left.path.localeCompare(right.path);
    return left.path.localeCompare(right.path);
  });
}

export function formatAttachmentBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GiB`;
}
