import { RangeSetBuilder, type Text } from "@codemirror/state";
import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import { findBooleanProperties } from "./frontmatter";

class YamlBooleanWidget extends WidgetType {
  constructor(
    private checked: boolean,
    private key: string,
    private from: number,
    private to: number,
  ) {
    super();
  }

  eq(other: YamlBooleanWidget): boolean {
    return this.checked === other.checked &&
      this.key === other.key && this.from === other.from && this.to === other.to;
  }

  toDOM(view: EditorView): HTMLElement {
    const label = document.createElement("label");
    label.className = "cm-yaml-bool-label";
    label.title = this.key;
    label.setAttribute("aria-label", this.key);
    const checkbox = document.createElement("input");
    checkbox.className = "cm-yaml-bool";
    checkbox.type = "checkbox";
    checkbox.checked = this.checked;
    checkbox.addEventListener("mousedown", (event) => event.stopPropagation());
    checkbox.addEventListener("change", () => {
      const current = view.state.sliceDoc(this.from, this.to).toLowerCase();
      if (current !== "true" && current !== "false") return;
      view.dispatch({
        changes: { from: this.from, to: this.to, insert: checkbox.checked ? "true" : "false" },
        userEvent: "input",
      });
      view.focus();
    });
    label.appendChild(checkbox);
    return label;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

function booleanDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const frontmatter = frontmatterForDecorations(view.state.doc);
  for (const property of findBooleanProperties(frontmatter.source)) {
    builder.add(
      property.from,
      property.to,
      Decoration.replace({
        widget: new YamlBooleanWidget(
          property.value,
          property.key,
          property.from,
          property.to,
        ),
      }),
    );
  }
  return builder.finish();
}

const MAX_FRONTMATTER_LINES = 4096;
const MAX_FRONTMATTER_CHARS = 256 * 1024;

/** Read only the frontmatter prefix; never stringify the Markdown body. */
export function frontmatterForDecorations(doc: Text): { source: string; end: number } {
  if (doc.lines === 0 || doc.line(1).text.replace(/\r$/, "") !== "---") {
    return { source: "", end: 0 };
  }
  const lineLimit = Math.min(doc.lines, MAX_FRONTMATTER_LINES);
  for (let number = 2; number <= lineLimit; number++) {
    const line = doc.line(number);
    if (line.from > MAX_FRONTMATTER_CHARS) break;
    const text = line.text.replace(/\r$/, "");
    if (text === "---" || text === "...") {
      return { source: doc.sliceString(0, line.to), end: line.to };
    }
  }
  return { source: "", end: 0 };
}

function touchesFrontmatter(update: ViewUpdate, end: number): boolean {
  if (end === 0) {
    let touchesStart = false;
    update.changes.iterChangedRanges((fromA) => {
      if (fromA <= 3) touchesStart = true;
    });
    return touchesStart;
  }
  let touches = false;
  update.changes.iterChangedRanges((fromA, toA) => {
    if (fromA <= end || toA <= end) touches = true;
  });
  return touches;
}

export const yamlBooleanPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    frontmatterEnd: number;

    constructor(view: EditorView) {
      this.decorations = booleanDecorations(view);
      this.frontmatterEnd = frontmatterForDecorations(view.state.doc).end;
    }

    update(update: ViewUpdate) {
      if (!update.docChanged) return;
      if (touchesFrontmatter(update, this.frontmatterEnd)) {
        this.decorations = booleanDecorations(update.view);
        this.frontmatterEnd = frontmatterForDecorations(update.state.doc).end;
      } else {
        this.decorations = this.decorations.map(update.changes);
      }
    }
  },
  {
    decorations: (plugin) => plugin.decorations,
    provide: (plugin) => EditorView.atomicRanges.of(
      (view) => view.plugin(plugin)?.decorations || Decoration.none,
    ),
  },
);
