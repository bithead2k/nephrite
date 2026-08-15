/**
 * Line-based two- and three-way merge for the full-file merge editor.
 * Common prefix/suffix stay auto-merged; the middle becomes a conflict the
 * user can edit. This is a merge UI, not a replacement for `git mergetool`.
 */

export type MergeInput = {
  leftLabel: string;
  rightLabel: string;
  left: string;
  right: string;
  base?: string | null;
  result?: string;
  title?: string;
};

export function splitKeepEnd(text: string): string[] {
  if (text === "") return [];
  return text.split(/(?<=\n)/);
}

export function commonPrefixLength(left: string[], right: string[]): number {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left[index] === right[index]) index += 1;
  return index;
}

export function commonSuffixLength(left: string[], right: string[], prefix: number): number {
  const leftRemain = left.length - prefix;
  const rightRemain = right.length - prefix;
  const limit = Math.min(leftRemain, rightRemain);
  let index = 0;
  while (
    index < limit &&
    left[left.length - 1 - index] === right[right.length - 1 - index]
  ) {
    index += 1;
  }
  return index;
}

/** Three-way: take a side when the other matches base; otherwise two-way. */
export function mergeTexts(ours: string, theirs: string, base?: string | null): string {
  if (ours === theirs) return ours;
  if (base != null) {
    if (ours === base) return theirs;
    if (theirs === base) return ours;
  }
  return mergeTwoWay(ours, theirs);
}

export function mergeTwoWay(left: string, right: string): string {
  if (left === right) return left;
  const leftLines = splitKeepEnd(left);
  const rightLines = splitKeepEnd(right);
  const prefix = commonPrefixLength(leftLines, rightLines);
  const suffix = commonSuffixLength(leftLines, rightLines, prefix);
  const head = leftLines.slice(0, prefix).join("");
  const tail = suffix ? leftLines.slice(leftLines.length - suffix).join("") : "";
  const leftMid = leftLines.slice(prefix, leftLines.length - suffix).join("");
  const rightMid = rightLines.slice(prefix, rightLines.length - suffix).join("");
  if (!leftMid) return `${head}${rightMid}${tail}`;
  if (!rightMid) return `${head}${leftMid}${tail}`;
  const leftBlock = leftMid.endsWith("\n") ? leftMid : `${leftMid}\n`;
  const rightBlock = rightMid.endsWith("\n") ? rightMid : `${rightMid}\n`;
  return `${head}<<<<<<< ours\n${leftBlock}=======\n${rightBlock}>>>>>>> theirs\n${tail}`;
}

export type MergeDialogResult = { content: string } | null;

export function showMergeEditor(
  input: MergeInput,
  host: HTMLElement,
): Promise<MergeDialogResult> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "nephrite-dialog file-merge-dialog";
    const box = document.createElement("form");
    box.className = "nephrite-dialog-box file-merge-box";
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-modal", "true");

    const title = document.createElement("strong");
    title.className = "nephrite-dialog-title";
    title.textContent = input.title ?? "Merge files";

    const panes = document.createElement("div");
    panes.className = "file-merge-panes";

    const left = labeledPane(input.leftLabel, input.left, true);
    const right = labeledPane(input.rightLabel, input.right, true);
    const result = labeledPane(
      "Result",
      input.result ?? mergeTexts(input.left, input.right, input.base),
      false,
    );
    panes.append(left.wrap, right.wrap, result.wrap);

    const footer = document.createElement("div");
    footer.className = "nephrite-dialog-actions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "nephrite-dialog-btn";
    cancel.textContent = "Cancel";
    const apply = document.createElement("button");
    apply.type = "submit";
    apply.className = "nephrite-dialog-btn nephrite-dialog-ok";
    apply.textContent = "Apply merge";
    footer.append(cancel, apply);

    box.append(title, panes, footer);
    overlay.appendChild(box);
    host.appendChild(overlay);

    const done = (value: MergeDialogResult) => {
      overlay.remove();
      resolve(value);
    };
    box.addEventListener("submit", (event) => {
      event.preventDefault();
      done({ content: result.area.value });
    });
    cancel.addEventListener("click", () => done(null));
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) done(null);
    });
    overlay.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        done(null);
      }
    });
    requestAnimationFrame(() => result.area.focus());
  });
}

function labeledPane(label: string, value: string, readOnly: boolean) {
  const wrap = document.createElement("label");
  wrap.className = "file-merge-pane";
  const caption = document.createElement("span");
  caption.textContent = label;
  const area = document.createElement("textarea");
  area.className = "file-merge-text";
  area.value = value;
  area.spellcheck = false;
  area.readOnly = readOnly;
  wrap.append(caption, area);
  return { wrap, area };
}
