import type { FootnoteEditTarget } from "./footnotes";

export type FootnoteComposerResult = {
  content: string;
  style: "inline" | "reference";
};

let activeComposer: HTMLElement | null = null;
let cancelActiveComposer: (() => void) | null = null;

export function openFootnoteComposer(
  target: FootnoteEditTarget,
  anchor: DOMRect | null,
): Promise<FootnoteComposerResult | null> {
  cancelActiveComposer?.();
  return new Promise((resolve) => {
    const form = document.createElement("form");
    form.className = "footnote-composer";
    form.setAttribute("role", "dialog");
    form.setAttribute("aria-label", target.kind === "new" ? "Insert footnote" : "Edit footnote");

    const header = document.createElement("div");
    header.className = "footnote-composer-header";
    const title = document.createElement("strong");
    title.textContent = target.kind === "new" ? "Insert footnote" : `Edit ${target.label?.startsWith("inline-") ? "inline footnote" : `footnote ${target.label ?? ""}`}`;
    const close = document.createElement("button");
    close.type = "button";
    close.className = "footnote-composer-close";
    close.setAttribute("aria-label", "Cancel footnote editing");
    close.textContent = "×";
    header.append(title, close);

    const textarea = document.createElement("textarea");
    textarea.className = "footnote-composer-input";
    textarea.rows = 4;
    textarea.placeholder = "Footnote text…";
    textarea.value = target.markdown;

    const footer = document.createElement("div");
    footer.className = "footnote-composer-footer";
    const style = document.createElement("select");
    style.className = "footnote-composer-style";
    style.setAttribute("aria-label", "Footnote style");
    style.innerHTML = `<option value="inline">Inline ^[…]</option><option value="reference">Reference [^1]</option>`;
    style.hidden = target.kind !== "new";
    const hint = document.createElement("span");
    hint.textContent = target.missing ? "This marker has no definition; saving will create it." : "Ctrl+Enter to save";
    if (target.missing) hint.className = "footnote-composer-warning";
    const save = document.createElement("button");
    save.type = "submit";
    save.className = "footnote-composer-save";
    save.textContent = "Save";
    footer.append(style, hint, save);
    form.append(header, textarea, footer);
    document.body.append(form);
    activeComposer = form;
    positionComposer(form, anchor);

    let finished = false;
    const done = (result: FootnoteComposerResult | null) => {
      if (finished) return;
      finished = true;
      document.removeEventListener("pointerdown", outside, true);
      form.remove();
      if (activeComposer === form) activeComposer = null;
      if (cancelActiveComposer === cancel) cancelActiveComposer = null;
      resolve(result);
    };
    const cancel = () => done(null);
    cancelActiveComposer = cancel;
    const outside = (event: Event) => {
      if (!form.contains(event.target as Node)) done(null);
    };
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (!textarea.value.trim()) return;
      done({ content: textarea.value, style: style.value === "reference" ? "reference" : "inline" });
    });
    form.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        done(null);
      } else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        form.requestSubmit();
      }
    });
    close.addEventListener("click", () => done(null));
    window.setTimeout(() => document.addEventListener("pointerdown", outside, true), 0);
    requestAnimationFrame(() => {
      textarea.focus();
      textarea.select();
    });
  });
}

function positionComposer(form: HTMLElement, anchor: DOMRect | null): void {
  const margin = 12;
  const rect = form.getBoundingClientRect();
  const anchorLeft = anchor?.left ?? window.innerWidth / 2;
  const anchorBottom = anchor?.bottom ?? window.innerHeight / 3;
  const anchorTop = anchor?.top ?? anchorBottom;
  const left = Math.max(margin, Math.min(anchorLeft, window.innerWidth - rect.width - margin));
  const below = anchorBottom + 8;
  const top = below + rect.height <= window.innerHeight - margin
    ? below
    : Math.max(margin, anchorTop - rect.height - 8);
  form.style.left = `${left}px`;
  form.style.top = `${top}px`;
}
