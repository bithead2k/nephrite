export type TimestampPart = "date" | "time";

/** Format a local date or time without converting through UTC. */
export function formatTimestampPart(part: TimestampPart, now = new Date()): string {
  const year = String(now.getFullYear()).padStart(4, "0");
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  const hour = String(now.getHours()).padStart(2, "0");
  const minute = String(now.getMinutes()).padStart(2, "0");
  const second = String(now.getSeconds()).padStart(2, "0");
  return part === "date" ? `${year}-${month}-${day}` : `${hour}:${minute}:${second}`;
}
