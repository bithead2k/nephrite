export type QueryDiagnosticDetails = Record<string, unknown>;

const MAX_ENTRIES = 250;
const entries: string[] = [];

export function queryDiagnostic(event: string, details: QueryDiagnosticDetails = {}): void {
  const safe = Object.fromEntries(
    Object.entries(details).filter(([, value]) =>
      value == null || ["string", "number", "boolean"].includes(typeof value)
    ),
  );
  const line = `${new Date().toISOString()} ${event} ${JSON.stringify(safe)}`;
  entries.push(line);
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
  console.info(`[query] ${event}`, safe);
}

export function queryDiagnosticText(): string {
  return entries.length ? entries.join("\n") : "No query-rendering events recorded yet.";
}

export function clearQueryDiagnostics(): void {
  entries.length = 0;
}

