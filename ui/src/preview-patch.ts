export type PreviewPatchWindow = {
  prefix: number;
  currentEnd: number;
  nextEnd: number;
};

/** Find the smallest contiguous top-level window that differs. */
export function previewPatchWindow(
  current: readonly string[],
  next: readonly string[],
): PreviewPatchWindow {
  let prefix = 0;
  const commonLength = Math.min(current.length, next.length);
  while (prefix < commonLength && current[prefix] === next[prefix]) prefix++;

  let suffix = 0;
  while (
    suffix < current.length - prefix &&
    suffix < next.length - prefix &&
    current[current.length - 1 - suffix] === next[next.length - 1 - suffix]
  ) suffix++;

  return {
    prefix,
    currentEnd: current.length - suffix,
    nextEnd: next.length - suffix,
  };
}

export type PreviewPatchResult = {
  preserved: number;
  removed: number;
  inserted: number;
  full: boolean;
};

/**
 * Preserve equal top-level preview nodes (and their listeners/state), replacing
 * only the contiguous region whose rendered HTML changed.
 */
export function patchPreviewHtml(
  root: HTMLElement,
  html: string,
  forceFull = false,
): PreviewPatchResult {
  const template = document.createElement("template");
  template.innerHTML = html;
  const currentNodes = Array.from(root.children);
  const nextNodes = Array.from(template.content.children);
  const nextKeys = nextNodes.map((node) => previewNodeKey(node.outerHTML));
  nextNodes.forEach((node, index) => {
    (node as HTMLElement).dataset.previewKey = nextKeys[index];
  });

  if (forceFull || currentNodes.length === 0) {
    root.replaceChildren(template.content);
    return {
      preserved: 0,
      removed: currentNodes.length,
      inserted: nextNodes.length,
      full: true,
    };
  }

  const window = previewPatchWindow(
    currentNodes.map((node) =>
      (node as HTMLElement).dataset.previewKey || previewNodeKey(node.outerHTML)),
    nextKeys,
  );
  if (window.prefix === currentNodes.length && window.prefix === nextNodes.length) {
    return { preserved: currentNodes.length, removed: 0, inserted: 0, full: false };
  }

  const removed = window.currentEnd - window.prefix;
  const inserted = window.nextEnd - window.prefix;
  const anchor = currentNodes[window.currentEnd] ?? null;
  for (let index = window.prefix; index < window.currentEnd; index++) {
    currentNodes[index].remove();
  }
  const fragment = document.createDocumentFragment();
  for (let index = window.prefix; index < window.nextEnd; index++) {
    fragment.appendChild(nextNodes[index]);
  }
  root.insertBefore(fragment, anchor);
  return {
    preserved: window.prefix + (currentNodes.length - window.currentEnd),
    removed,
    inserted,
    full: false,
  };
}

/** Stable, non-cryptographic identity for rendered source HTML. */
function previewNodeKey(source: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index++) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}
