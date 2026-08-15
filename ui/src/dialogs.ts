/**
 * In-app modal dialogs replacing native confirm()/alert()/prompt().
 * Promise-based; styles live in styles.css under `.nephrite-dialog`.
 */

type DialogKind = "alert" | "confirm" | "prompt";

export type DialogOptions = {
  title?: string;
  kind?: DialogKind;
  defaultValue?: string;
  danger?: boolean;
  placeholder?: string;
};

let host: HTMLDivElement | null = null;

function ensureHost(): HTMLDivElement {
  if (host && host.isConnected) return host;
  host = document.createElement("div");
  host.className = "nephrite-dialog-host";
  document.body.appendChild(host);
  return host;
}

function closeHost() {
  if (host && host.isConnected) host.remove();
}

function open(kind: DialogKind, message: string, options: DialogOptions = {}): Promise<unknown> {
  const overlay = document.createElement("div");
  overlay.className = "nephrite-dialog";
  const box = document.createElement("form");
  box.className = "nephrite-dialog-box";
  box.setAttribute("role", kind === "alert" ? "alertdialog" : "dialog");
  box.setAttribute("aria-modal", "true");

  const title = options.title ?? (kind === "prompt" ? "Nephrite" : kind === "confirm" ? "Confirm" : "Notice");
  const titleEl = document.createElement("strong");
  titleEl.className = "nephrite-dialog-title";
  titleEl.textContent = title;

  const messageEl = document.createElement("p");
  messageEl.className = "nephrite-dialog-message";
  messageEl.textContent = message;

  const inputEl = document.createElement("input");
  inputEl.type = "text";
  inputEl.className = "nephrite-dialog-input";
  inputEl.value = options.defaultValue ?? "";
  inputEl.placeholder = options.placeholder ?? "";
  inputEl.spellcheck = false;

  const footer = document.createElement("div");
  footer.className = "nephrite-dialog-actions";

  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "nephrite-dialog-btn";
  cancelBtn.textContent = "Cancel";
  const okBtn = document.createElement("button");
  okBtn.type = "submit";
  okBtn.className = `nephrite-dialog-btn nephrite-dialog-ok${options.danger ? " danger" : ""}`;
  okBtn.textContent = kind === "confirm" ? "Confirm" : "OK";

  let resolveFn: (value: unknown) => void = () => {};
  const done = (value: unknown) => {
    overlay.remove();
    closeHost();
    resolveFn(value);
  };

  box.append(titleEl, messageEl);
  if (kind === "prompt") box.appendChild(inputEl);
  if (kind !== "alert") footer.appendChild(cancelBtn);
  footer.appendChild(okBtn);
  box.appendChild(footer);

  box.addEventListener("submit", (event) => {
    event.preventDefault();
    if (kind === "prompt") {
      const value = inputEl.value;
      done(value.trim() === "" ? null : value.trim());
    } else {
      done(true);
    }
  });
  cancelBtn.addEventListener("click", () => done(false));
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) done(false);
  });
  overlay.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      done(false);
    }
  });

  overlay.appendChild(box);
  ensureHost().appendChild(overlay);

  requestAnimationFrame(() => {
    if (kind === "prompt") {
      inputEl.focus();
      inputEl.select();
    } else {
      okBtn.focus();
    }
  });

  return new Promise((resolve) => {
    resolveFn = resolve;
  });
}

/** Non-blocking alert; resolves when the user dismisses it. */
export function uiAlert(message: string, options?: DialogOptions): Promise<void> {
  return open("alert", message, options) as Promise<void>;
}

/** Resolves true (Confirm / Enter) or false (Cancel / Escape / click-outside). */
export function uiConfirm(message: string, options?: DialogOptions): Promise<boolean> {
  return open("confirm", message, options) as Promise<boolean>;
}

/** Resolves the trimmed value, or null on cancel. */
export function uiPrompt(message: string, options?: DialogOptions): Promise<string | null> {
  return open("prompt", message, options) as Promise<string | null>;
}

export type PickFileOption = { path: string; title?: string };

/** Searchable vault-file picker. Resolves a path or null on cancel. */
export function uiPickFile(
  files: readonly PickFileOption[],
  options: { title?: string; exclude?: string } = {},
): Promise<string | null> {
  const overlay = document.createElement("div");
  overlay.className = "nephrite-dialog";
  const box = document.createElement("form");
  box.className = "nephrite-dialog-box file-pick-box";
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-modal", "true");

  const title = document.createElement("strong");
  title.className = "nephrite-dialog-title";
  title.textContent = options.title ?? "Choose a file";

  const input = document.createElement("input");
  input.type = "search";
  input.className = "nephrite-dialog-input";
  input.placeholder = "Filter by path…";
  input.spellcheck = false;

  const list = document.createElement("div");
  list.className = "file-pick-list";

  const candidates = files.filter((file) => file.path !== options.exclude);
  let matches = candidates;
  let active = 0;

  const draw = () => {
    const query = input.value.trim().toLowerCase();
    matches = query
      ? candidates.filter((file) => file.path.toLowerCase().includes(query))
      : candidates;
    active = Math.max(0, Math.min(active, matches.length - 1));
    list.replaceChildren();
    for (const [index, file] of matches.slice(0, 80).entries()) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `file-pick-item${index === active ? " active" : ""}`;
      button.textContent = file.title ?? file.path;
      button.title = file.path;
      button.addEventListener("mousemove", () => {
        if (active === index) return;
        active = index;
        list.querySelector(".active")?.classList.remove("active");
        button.classList.add("active");
      });
      button.addEventListener("click", () => done(file.path));
      list.appendChild(button);
    }
    if (!matches.length) {
      const empty = document.createElement("div");
      empty.className = "file-pick-empty";
      empty.textContent = "No matching files.";
      list.appendChild(empty);
    }
  };

  let resolveFn: (value: string | null) => void = () => {};
  const done = (value: string | null) => {
    overlay.remove();
    closeHost();
    resolveFn(value);
  };

  const footer = document.createElement("div");
  footer.className = "nephrite-dialog-actions";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "nephrite-dialog-btn";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", () => done(null));
  footer.appendChild(cancel);

  box.append(title, input, list, footer);
  overlay.appendChild(box);
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) done(null);
  });
  box.addEventListener("submit", (event) => {
    event.preventDefault();
    done(matches[active]?.path ?? null);
  });
  overlay.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      done(null);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      active = Math.min(active + 1, Math.max(0, matches.length - 1));
      draw();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      active = Math.max(active - 1, 0);
      draw();
    }
  });
  input.addEventListener("input", draw);
  ensureHost().appendChild(overlay);
  draw();
  requestAnimationFrame(() => input.focus());
  return new Promise((resolve) => {
    resolveFn = resolve;
  });
}
