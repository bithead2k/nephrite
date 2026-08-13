/**
 * Fence-aware markdown block splitting for incremental preview.
 * Full-document parse remains the fallback when structure shifts.
 */

export type BlockPlan =
  | { kind: "full"; reason: string }
  | { kind: "noop" }
  | { kind: "patch"; blocks: string[]; changed: number[] }
  /** Body DOM unchanged; YAML changed — refresh props + re-run SQL/dataview. */
  | { kind: "yaml"; blocks: string[] };

/** Split markdown body into stable blocks (never splits inside fences). */
export function splitMarkdownBlocks(body: string): string[] {
  const text = body.replace(/\r\n/g, "\n");
  if (!text.trim()) return [""];

  const lines = text.split("\n");
  const blocks: string[] = [];
  let buf: string[] = [];
  let inFence = false;
  let fenceToken = "";

  const flush = () => {
    if (buf.length === 0) return;
    blocks.push(buf.join("\n"));
    buf = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (inFence) {
      buf.push(line);
      // Closing fence: line begins with the same fence char run (3+), optional info ignored.
      if (fenceToken && line.startsWith(fenceToken) && !line.slice(fenceToken.length).trim().startsWith(fenceToken[0])) {
        // Standard close: ``` or ~~~ at BOL (allow trailing whitespace only)
        const rest = line.slice(fenceToken.length);
        if (rest.trim() === "") {
          inFence = false;
          fenceToken = "";
          flush();
        }
      }
      continue;
    }

    const fenceOpen = line.match(/^(`{3,}|~{3,})(.*)$/);
    if (fenceOpen) {
      flush();
      inFence = true;
      fenceToken = fenceOpen[1];
      buf.push(line);
      continue;
    }

    // ATX heading starts a new block.
    if (/^#{1,6}\s+\S/.test(line)) {
      flush();
      buf.push(line);
      continue;
    }

    // Blank line ends the current block (paragraph / list run).
    if (line.trim() === "") {
      if (buf.length > 0) {
        buf.push(line);
        flush();
      } else {
        // Leading blanks: keep with following content by skipping pure leading empties
        // unless we need to preserve document shape — attach to next block via ignore.
      }
      continue;
    }

    buf.push(line);
  }
  flush();
  return blocks.length > 0 ? blocks : [text];
}

export function blockHash(source: string): string {
  const normalized = source.replace(/\s+/g, " ").trim();
  let hash = 0x811c9dc5;
  for (let i = 0; i < normalized.length; i++) {
    hash ^= normalized.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

/**
 * Decide whether this edit is a trivial in-place block change or needs a full parse.
 * `previous` / `next` are **body** markdown (no frontmatter).
 */
export function planBlockUpdate(previous: string | null, next: string): BlockPlan {
  if (previous === next) return { kind: "noop" };
  if (previous == null || previous === "") {
    return { kind: "full", reason: "no-baseline" };
  }

  const prevBlocks = splitMarkdownBlocks(previous);
  const nextBlocks = splitMarkdownBlocks(next);

  // Structural change: different block count → full parse (list split, new heading, etc.).
  if (prevBlocks.length !== nextBlocks.length) {
    return { kind: "full", reason: "block-count" };
  }

  const changed: number[] = [];
  for (let i = 0; i < nextBlocks.length; i++) {
    if (blockHash(prevBlocks[i]) !== blockHash(nextBlocks[i])) {
      changed.push(i);
    }
  }

  if (changed.length === 0) return { kind: "noop" };

  // Too many dirty blocks → cheaper / safer to full-render once.
  if (changed.length > 3) {
    return { kind: "full", reason: "many-dirty" };
  }

  // Fence imbalance in any dirty block → full parse.
  for (const index of changed) {
    if (fenceImbalanced(nextBlocks[index])) {
      return { kind: "full", reason: "fence-imbalance" };
    }
  }

  return { kind: "patch", blocks: nextBlocks, changed };
}

export type FrontmatterSplit = {
  yaml: string | null;
  body: string;
  hasFrontmatter: boolean;
};

/**
 * Plan a preview update from full note text (YAML + body).
 * YAML-only edits return `yaml` so callers can refresh props and invalidate
 * SQL/dataview without re-parsing the body DOM.
 */
export function planPreviewUpdate(
  previous: string | null,
  next: string,
  split: (markdown: string) => FrontmatterSplit,
): BlockPlan {
  if (previous === next) return { kind: "noop" };
  if (previous == null || previous === "") {
    return { kind: "full", reason: "no-baseline" };
  }

  const prev = split(previous);
  const nxt = split(next);
  const bodyPlan = planBlockUpdate(prev.body, nxt.body);

  if (bodyPlan.kind === "full") return bodyPlan;
  if (bodyPlan.kind === "patch") return bodyPlan;

  // Body unchanged (noop). Check frontmatter.
  if ((prev.yaml ?? "") !== (nxt.yaml ?? "") || prev.hasFrontmatter !== nxt.hasFrontmatter) {
    return {
      kind: "yaml",
      blocks: splitMarkdownBlocks(nxt.body),
    };
  }

  return { kind: "noop" };
}

function fenceImbalanced(block: string): boolean {
  const lines = block.split("\n");
  let open = 0;
  let token = "";
  for (const line of lines) {
    const m = line.match(/^(`{3,}|~{3,})(.*)$/);
    if (!m) continue;
    if (open === 0) {
      open = 1;
      token = m[1];
      continue;
    }
    if (line.startsWith(token) && line.slice(token.length).trim() === "") {
      open = 0;
      token = "";
    }
  }
  return open !== 0;
}
