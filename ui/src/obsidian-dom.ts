/**
 * Obsidian patches HTMLElement / DocumentFragment with helpers such as
 * empty(), createEl(), and addClass(). Community settings tabs call those
 * on containerEl. Keep this function self-contained — its source is injected
 * into the plugin iframe via Function.prototype.toString().
 */
export function installObsidianDom(scope: {
  HTMLElement: { prototype: object };
  DocumentFragment: { prototype: object };
  Node?: { prototype: object };
  document: { createElement: (tag: string) => object };
}): void {
  const htmlProto = scope.HTMLElement.prototype as Record<string, unknown>;
  const fragmentProto = scope.DocumentFragment.prototype as Record<string, unknown>;

  const classList = (value: unknown): string[] => {
    if (Array.isArray(value)) return value.flatMap(classList);
    return String(value ?? "").split(/\s+/).filter(Boolean);
  };

  const applyInfo = (el: Record<string, unknown>, info: unknown) => {
    if (info == null) return;
    if (typeof info === "string") {
      (el as { className: string }).className = info;
      return;
    }
    const record = info as Record<string, unknown>;
    const list = (el as { classList: { add: (...names: string[]) => void } }).classList;
    if (record.cls != null) list.add(...classList(record.cls));
    if (record.text != null) {
      const node = record.text as { nodeType?: number };
      if (node && typeof node === "object" && typeof node.nodeType === "number") {
        (el as { append: (node: unknown) => void }).append(record.text);
      } else {
        (el as { textContent: string }).textContent = String(record.text);
      }
    }
    if (record.attr && typeof record.attr === "object") {
      for (const [key, value] of Object.entries(record.attr as Record<string, unknown>)) {
        if (value == null || value === false) (el as { removeAttribute: (name: string) => void }).removeAttribute(key);
        else (el as { setAttribute: (name: string, value: string) => void }).setAttribute(key, value === true ? "" : String(value));
      }
    }
    if (record.title != null) (el as { title: string }).title = String(record.title);
    if (record.href != null) (el as { setAttribute: (name: string, value: string) => void }).setAttribute("href", String(record.href));
    if (record.type != null) (el as { setAttribute: (name: string, value: string) => void }).setAttribute("type", String(record.type));
    if (record.placeholder != null) (el as { setAttribute: (name: string, value: string) => void }).setAttribute("placeholder", String(record.placeholder));
    if (record.value != null && "value" in el) (el as { value: string }).value = String(record.value);
  };

  const createEl = function (
    this: { append: (node: object) => void; prepend?: (node: object) => void },
    tag: string,
    info?: unknown,
    callback?: (el: object) => void,
  ) {
    const el = scope.document.createElement(tag) as Record<string, unknown>;
    applyInfo(el, info);
    if (typeof callback === "function") callback(el);
    const prepend = info && typeof info === "object" && (info as { prepend?: boolean }).prepend;
    if (prepend && typeof this.prepend === "function") this.prepend(el);
    else this.append(el);
    return el;
  };

  const helpers: Record<string, unknown> = {
    empty() {
      (this as { replaceChildren: () => void }).replaceChildren();
      return this;
    },
    detach() {
      const node = this as { parentNode?: { removeChild: (node: unknown) => void } | null };
      node.parentNode?.removeChild(this);
      return this;
    },
    setText(value: unknown) {
      (this as { textContent: string }).textContent = value == null ? "" : String(value);
      return this;
    },
    addClass(...names: unknown[]) {
      (this as { classList: { add: (...cls: string[]) => void } }).classList.add(...classList(names));
      return this;
    },
    removeClass(...names: unknown[]) {
      (this as { classList: { remove: (...cls: string[]) => void } }).classList.remove(...classList(names));
      return this;
    },
    toggleClass(name: unknown, force?: boolean) {
      (this as { classList: { toggle: (cls: string, force?: boolean) => void } }).classList.toggle(String(name), force);
      return this;
    },
    hasClass(name: unknown) {
      return (this as { classList: { contains: (cls: string) => boolean } }).classList.contains(String(name));
    },
    createEl,
    createDiv(info?: unknown, callback?: (el: object) => void) {
      return createEl.call(this as { append: (node: object) => void }, "div", info, callback);
    },
    createSpan(info?: unknown, callback?: (el: object) => void) {
      return createEl.call(this as { append: (node: object) => void }, "span", info, callback);
    },
  };

  for (const [name, value] of Object.entries(helpers)) {
    if (typeof htmlProto[name] !== "function") htmlProto[name] = value;
    if (name.startsWith("create") || name === "empty" || name === "setText") {
      if (typeof fragmentProto[name] !== "function") fragmentProto[name] = value;
    }
  }
}
