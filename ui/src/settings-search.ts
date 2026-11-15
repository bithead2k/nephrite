export type SettingsSearchController = {
  filter: (query: string) => number;
  destroy: () => void;
};

const ITEM_SELECTOR = ".preferences-section, .preferences-body > .preferences-action, .preferences-body > .preference-toggle";

export function bindSettingsSearch(
  input: HTMLInputElement,
  body: HTMLElement,
  status: HTMLElement,
): SettingsSearchController {
  const items = () => Array.from(body.querySelectorAll<HTMLElement>(ITEM_SELECTOR));
  const filter = (query: string) => {
    const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    let visible = 0;
    for (const item of items()) {
      const matches = !terms.length || terms.every((term) => (item.textContent ?? "").toLocaleLowerCase().includes(term));
      item.hidden = !matches;
      if (matches) visible += 1;
    }
    status.textContent = terms.length ? `${visible} setting${visible === 1 ? "" : "s"} found` : "";
    return visible;
  };
  const onInput = () => filter(input.value);
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape" && input.value) {
      input.value = "";
      filter("");
      event.preventDefault();
      return;
    }
    if (event.key !== "ArrowDown") return;
    const target = items()
      .filter((item) => !item.hidden)
      .flatMap((item) => Array.from(item.matches("button, input, select, textarea") ? [item] : item.querySelectorAll<HTMLElement>("button, input, select, textarea")))
      .find((element) => !(element as HTMLButtonElement).disabled);
    if (target) {
      target.focus();
      event.preventDefault();
    }
  };
  input.addEventListener("input", onInput);
  input.addEventListener("keydown", onKeyDown);
  return {
    filter,
    destroy() {
      input.removeEventListener("input", onInput);
      input.removeEventListener("keydown", onKeyDown);
      for (const item of items()) item.hidden = false;
    },
  };
}
