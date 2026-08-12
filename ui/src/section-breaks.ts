import {
  Decoration,
  DecorationSet,
  EditorView,
  MatchDecorator,
  ViewPlugin,
  ViewUpdate,
} from "@codemirror/view";

/** Keep literal Markdown thematic-break lines visible regardless of parse context. */
export function sectionBreakPlugin() {
  const decorator = new MatchDecorator({
    regexp: /^[ \t]{0,3}(?:-{3,}|\*{3,}|_{3,})[ \t]*$/gm,
    decoration: Decoration.mark({ class: "cm-section-break" }),
  });

  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = decorator.createDeco(view);
      }

      update(update: ViewUpdate) {
        this.decorations = decorator.updateDeco(update, this.decorations);
      }
    },
    { decorations: (value) => value.decorations },
  );
}
