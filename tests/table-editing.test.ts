import assert from "node:assert/strict";
import test from "node:test";
import { EditorSelection, EditorState, Transaction } from "@codemirror/state";
import { history, undo, redo } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { formatTableRanges, liveTableFormatting } from "../ui/src/table-editing";
import { tableAlignments, tableCells } from "../ui/src/markdown-tables";
import { renderPreview } from "../ui/src/preview";

const source = "| Left | Centered | Right | Left | Block Justified |\n| :--- | :-------: | ----: | --- | -:-----------:- |\n| one | two | three | four | some words |";
function state(doc = source) {
  return EditorState.create({ doc, extensions: [markdown(), history(), liveTableFormatting()] });
}
function type(s: EditorState, pos: number, text: string) {
  return s.update({ changes: { from: pos, insert: text }, selection: { anchor: pos + text.length }, userEvent: "input.type" }).state;
}

test("all five column markers render, including block justification", () => {
  assert.deepEqual(tableAlignments(source.split("\n")[1]), ["left", "center", "right", null, "justify"]);
  const html = renderPreview(source);
  assert.match(html, /<table>/);
  assert.match(html, /<th style="text-align:justify;text-align-last:justify">Block Justified<\/th>/);
  assert.match(html, /<td style="text-align:justify;text-align-last:justify">some words<\/td>/);
  assert.match(html, /<th style="text-align:center">Centered/);
  assert.match(html, /<th style="text-align:right">Right/);
});

test("opening, reloading, and cursor movement never modify source", () => {
  let s = state();
  assert.equal(s.doc.toString(), source);
  s = s.update({ selection: { anchor: source.length - 2 } }).state;
  assert.equal(s.doc.toString(), source);
  s = s.update({ changes: { from: 0, to: s.doc.length, insert: source + "\n" } }).state;
  assert.equal(s.doc.toString(), source + "\n");
});

test("typing formats source column widths and keeps the caret in its cell", () => {
  const pos = source.indexOf("one") + 3;
  let s = type(state(), pos, " more");
  const lines = s.doc.toString().split("\n");
  assert.equal(new Set(lines.map(line => line.length)).size, 1);
  assert.deepEqual(tableCells(lines[1])!.map(cell => cell.to), tableCells(lines[2])!.map(cell => cell.to));
  assert.equal(s.doc.sliceString(s.selection.main.head - 8, s.selection.main.head), "one more");
  s = type(s, s.selection.main.head, " ");
  s = type(s, s.selection.main.head, "word");
  assert.match(s.doc.toString(), /one more word/);
});

test("formatting shares the edit's undo and redo transaction", () => {
  let s = type(state(), source.indexOf("one") + 3, "!");
  const formatted = s.doc.toString();
  const target = { get state() { return s; }, dispatch(t: Transaction) { s = t.state; } };
  assert.equal(undo(target), true);
  assert.equal(s.doc.toString(), source);
  assert.equal(redo(target), true);
  assert.equal(s.doc.toString(), formatted);
});

test("only the edited table changes, preserving CRLF serialization", () => {
  const doc = `before\r\n\r\n${source.replace(/\n/g, "\r\n")}\r\n\r\n${source.replace(/\n/g, "\r\n")}`;
  let s = EditorState.create({ doc, extensions: [EditorState.lineSeparator.of("\r\n"), liveTableFormatting()] });
  s = type(s, s.doc.toString().indexOf("one") + 3, "!");
  assert.ok(s.sliceDoc().endsWith(source.replace(/\n/g, "\r\n")));
  assert.ok(s.sliceDoc().startsWith("before\r\n\r\n"));
});

test("fences, frontmatter, indented code and HTML are left alone", () => {
  for (const doc of [`\`\`\`md\n${source}\n\`\`\``, `~~~\n${source}\n~~~`, `---\n${source}\n---`, source.split("\n").map(l => "    " + l).join("\n"), `<div>\n${source}\n</div>`]) {
    const pos = doc.indexOf("one") + 3;
    assert.equal(type(state(doc), pos, "!").doc.toString(), doc.slice(0, pos) + "!" + doc.slice(pos));
  }
});

test("escaped pipes, code pipes and wikilink aliases remain cell content", () => {
  const cells = tableCells('| a\\|b | `x|y` | [[Note|alias]] |');
  assert.deepEqual(cells?.map(c => c.text), ['a\\|b', '`x|y`', '[[Note|alias]]']);
  const doc = '| A | B | C |\n| --- | --- | -:---:- |\n| a\\|b | `x|y` | [[Note|alias]] |';
  const result = type(state(doc), doc.indexOf('a\\|b') + 1, '!').doc.toString();
  assert.match(result, /a!\\\|b/);
  assert.match(result, /`x\|y`/);
  assert.match(result, /\[\[Note\|alias\]\]/);
});

test("malformed tables and composing text are not rewritten", () => {
  const doc = '| A | B |\n| --- | --- |\n| only one |';
  const pos = doc.indexOf('only') + 4;
  assert.equal(type(state(doc), pos, '!').doc.toString(), doc.slice(0, pos) + '!' + doc.slice(pos));
  const s = EditorState.create({ doc: source, extensions: [liveTableFormatting(() => true)] }).update({ changes: { from: source.length, insert: '字' }, userEvent: 'input.type.compose' }).state;
  assert.equal(s.doc.toString(), source + '字');
});

test("preview preserves fenced examples and renders inline formatting in justified tables", () => {
  assert.doesNotMatch(renderPreview('```md\n' + source + '\n```'), /<table>/);
  assert.match(renderPreview('| Heading |\n| -:---:- |\n| **bold** |'), /<strong>bold<\/strong>/);
  assert.doesNotMatch(renderPreview('| A | B |\n| -:---:- |\n| one | two |'), /<table>/);
});

test("multiple carets keep their positions in independently formatted cells", () => {
  const s = EditorState.create({ doc: source, extensions: [EditorState.allowMultipleSelections.of(true), liveTableFormatting()] });
  const a = source.indexOf('one') + 3, b = source.indexOf('two') + 3;
  const next = s.update({ changes: [{ from: a, insert: '!' }, { from: b, insert: '?' }],
    selection: EditorSelection.create([EditorSelection.cursor(a + 1), EditorSelection.cursor(b + 2)]), userEvent: 'input.type' }).state;
  assert.equal(next.doc.sliceString(next.selection.ranges[0].head - 1, next.selection.ranges[0].head), '!');
  assert.equal(next.doc.sliceString(next.selection.ranges[1].head - 1, next.selection.ranges[1].head), '?');
});

test("block justification stretches Markdown prose and maps the caret through the spaces", () => {
  const doc = '| Block Justified |\n| -:-----------:- |\n| some words |';
  let s = type(state(doc), doc.indexOf('words') + 5, '!');
  assert.equal(tableCells(s.doc.line(3).text)![0].text, 'some     words!');
  assert.equal(s.doc.sliceString(s.selection.main.head - 6, s.selection.main.head), 'words!');
  s = type(s, s.selection.main.head, ' next');
  assert.match(s.doc.line(3).text, /words! next/);
  assert.equal(s.doc.sliceString(s.selection.main.head - 4, s.selection.main.head), 'next');
});

test("justification preserves whitespace inside inline constructs", () => {
  const doc = '| A very long header for sizing |\n| -:---:- |\n| `a b` [[Note|my alias]] end |';
  const s = type(state(doc), doc.indexOf('end') + 3, '!');
  assert.match(s.doc.line(3).text, /`a b`/);
  assert.match(s.doc.line(3).text, /\[\[Note\|my alias\]\]/);
});

test("Vim's compose-labelled edits format when no actual IME composition is active", () => {
  const pos = source.indexOf('one') + 3;
  const s = state().update({ changes: { from: pos, insert: '!' }, selection: { anchor: pos + 1 }, userEvent: 'input.type.compose' }).state;
  assert.equal(new Set(s.doc.toString().split('\n').map(line => line.length)).size, 1);
  assert.match(s.doc.toString(), /one!/);
});

test("standard table alignment overrides the preview's default left alignment", () => {
  const html = renderPreview('| Center | Right |\n| :---: | ---: |\n| c | r |');
  assert.match(html, /<th align="center" style="text-align:center">Center/);
  assert.match(html, /<td align="right" style="text-align:right">r/);
});

test("deletion shrinks columns and paste expands them, without touching adjacent text", () => {
  const doc = '| Header | Other |\n| --- | ---: |\n| abcdefghijkl | value |\n\nafter';
  let s = state(doc);
  const pos = doc.indexOf('abcdefghijkl');
  s = s.update({ changes: { from: pos + 3, to: pos + 12 }, selection: { anchor: pos + 3 }, userEvent: 'delete.backward' }).state;
  assert.equal(tableCells(s.doc.line(1).text)![0].to - tableCells(s.doc.line(1).text)![0].from, 8);
  const end = s.doc.toString().indexOf('value') + 5;
  s = s.update({ changes: { from: end, insert: ' with more text' }, userEvent: 'input.paste' }).state;
  assert.equal(s.doc.line(1).text.length, s.doc.line(3).text.length);
  assert.ok(s.doc.toString().endsWith('\n\nafter'));
});

test("source formatting supports large tables without touching fenced large-note examples", () => {
  const doc = '| A | B |\n| --- | --- |\n' + '| x | y |\n'.repeat(300);
  const s = type(state(doc), doc.indexOf('x') + 1, ' longer');
  assert.equal(s.doc.line(1).text.length, s.doc.line(302).text.length);
  const example = 'intro\n'.repeat(15000) + '```\n' + doc + '```';
  const pos = example.indexOf('| x') + 3;
  const large = type(EditorState.create({ doc: example, extensions: [liveTableFormatting()] }), pos, '!');
  assert.equal(large.doc.toString(), example.slice(0, pos) + '!' + example.slice(pos));
});

import { tableNavigation, tableAction, tableMenuChoices, tableFormatTargets, sortSourceTable, type TableAction } from "../ui/src/table-commands";
import { applyTableRepair, openTableRepair, planTableRepair } from "../ui/src/table-repair";

function at(s: EditorState, text: string) {
  return s.update({ selection: { anchor: s.doc.toString().indexOf(text) } }).state;
}
function selected(s: EditorState) { return s.sliceDoc(s.selection.main.from, s.selection.main.to); }

test("Tab and Shift+Tab navigate content, skipping the delimiter", () => {
  let s = at(state(), 'Left');
  s = s.update(tableNavigation(s, 1)!).state;
  assert.equal(selected(s), 'Centered');
  s = at(s, 'Block Justified');
  s = s.update(tableNavigation(s, 1)!).state;
  assert.equal(selected(s), 'one');
  s = s.update(tableNavigation(s, -1)!).state;
  assert.equal(selected(s), 'Block Justified');
  const unchanged = s.doc.toString();
  s = at(s, 'Left');
  s = s.update(tableNavigation(s, -1)!).state;
  assert.equal(selected(s), 'Left');
  assert.equal(s.doc.toString(), unchanged);
});

test("Tab at the last cell appends one empty row with a single undo", () => {
  let s = at(state(), 'some words');
  s = s.update(tableNavigation(s, 1)!).state;
  assert.equal(s.doc.lines, 4);
  assert.deepEqual(tableCells(s.doc.line(4).text)!.map(c => c.text), ['', '', '', '', '']);
  assert.equal(s.doc.lineAt(s.selection.main.head).number, 4);
  assert.equal(s.doc.sliceString(s.selection.main.head - 2, s.selection.main.head), '| ');
  const target = { get state() { return s; }, dispatch(t: Transaction) { s = t.state; } };
  undo(target);
  assert.equal(s.doc.toString(), source);
});

test("Tab works in a header-only table and leaves other text alone", () => {
  const doc = '| A | B |\n| --- | --- |';
  let s = at(state(doc), 'B');
  s = s.update(tableNavigation(s, 1)!).state;
  assert.equal(s.doc.lines, 3);
  assert.equal(tableNavigation(state('plain text'), 1), null);
  assert.equal(tableNavigation(at(state('```\n' + source + '\n```'), 'one'), 1), null);
  assert.equal(tableNavigation(at(state('| A | B |\n| missing | marker |'), 'missing'), 1), null);
  const selectedRows = state().update({ selection: { anchor: 2, head: source.length - 2 } }).state;
  assert.equal(tableNavigation(selectedRows, 1), null);
});

test("row commands insert, move, duplicate and delete without touching header/separator", () => {
  const doc = '| A | B |\n| :--- | ---: |\n| first | one |\n| second | two |';
  const run = (action: TableAction, target = 'second') => {
    const s = state(doc);
    return s.update(tableAction(s, doc.indexOf(target), action)!).state;
  };
  assert.equal(run('row-above').doc.lines, 5);
  assert.deepEqual(tableCells(run('row-below', 'A').doc.line(3).text)!.map(cell => cell.text), ['', '']);
  assert.equal(tableCells(run('row-up').doc.line(3).text)![0].text, 'second');
  assert.equal(tableCells(run('row-down', 'first').doc.line(4).text)![0].text, 'first');
  assert.equal(run('row-duplicate').doc.lines, 5);
  assert.equal(run('row-delete').doc.lines, 3);
  assert.equal(tableAction(state(doc), doc.indexOf('A'), 'row-delete'), null);
});

test("column commands move alignment with cells and can change the source marker", () => {
  const doc = '| A | B |\n| :--- | ---: |\n| first | second |';
  const s = state(doc), pos = doc.indexOf('second');
  const moved = s.update(tableAction(s, pos, 'column-left')!).state;
  assert.deepEqual(tableCells(moved.doc.line(1).text)!.map(c => c.text), ['B', 'A']);
  assert.deepEqual(tableAlignments(moved.doc.line(2).text), ['right', 'left']);
  for (const action of ['column-before', 'column-after', 'column-duplicate'] as const) {
    const next = s.update(tableAction(s, pos, action)!).state;
    assert.equal(tableCells(next.doc.line(1).text)!.length, 3);
    assert.equal(tableCells(next.doc.line(3).text)!.length, 3);
  }
  const removed = s.update(tableAction(s, pos, 'column-delete')!).state;
  assert.equal(tableCells(removed.doc.line(1).text)!.length, 1);
  for (const alignment of ['left', 'center', 'right', 'justify'] as const) {
    const aligned = s.update(tableAction(s, pos, `align-${alignment}`)!).state;
    assert.equal(tableAlignments(aligned.doc.line(2).text)![1], alignment);
  }
});

test("repair proposes missing delimiters and ragged cells without discarding extra content", () => {
  const doc = '| A | B |\n| one |\n| x | y | z |';
  const s = state(doc);
  const plan = planTableRepair(s, doc.indexOf('one'))!;
  assert.equal(s.doc.toString(), doc);
  assert.ok(plan.issues.some(issue => issue.includes('Missing separator')));
  assert.ok(plan.issues.some(issue => issue.includes('extra cells')));
  const lines = plan.after.split('\n');
  assert.equal(lines.length, 4);
  assert.ok(lines.every(line => tableCells(line)!.length === 3));
  assert.deepEqual(tableCells(lines[3])!.map(c => c.text), ['x', 'y', 'z']);
  assert.deepEqual(tableAlignments(lines[1]), [null, null, null]);
});

test("repair preserves protected code and wiki aliases and offers malformed marker repairs", () => {
  const doc = '| A | B |\n| --:: | -- |\n| `a|b` | [[Note|alias]] |';
  const plan = planTableRepair(state(doc), doc.indexOf('a|b'))!;
  assert.ok(plan.issues.some(issue => issue.includes('Malformed separator')));
  assert.match(plan.after, /`a\|b`/);
  assert.match(plan.after, /\[\[Note\|alias\]\]/);
  for (const protectedDoc of ['```\n' + doc + '\n```', '---\n' + doc + '\n---']) {
    assert.equal(planTableRepair(state(protectedDoc), protectedDoc.indexOf('a|b')), null);
  }
});

test("table context menu targets the clicked source cell and protects the last column", () => {
  const s = state();
  assert.ok(tableMenuChoices(s, source.indexOf('three')).some(item => item.label === 'Align column: right ✓'));
  const single = '| A |\n| --- |\n| b |';
  assert.ok(!tableMenuChoices(state(single), single.indexOf('b')).some(item => item.id === 'table-column-delete'));
  assert.equal(tableAction(state(single), single.indexOf('b'), 'column-delete'), null);
  assert.deepEqual(tableMenuChoices(state('ordinary text'), 0), []);
});

test("real editor Tab binding and repair panel apply/cancel/stale handling", async () => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
  for (const key of ['window', 'document', 'navigator', 'MutationObserver', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement', 'DOMParser', 'Node', 'Window', 'DOMRect'] as const) {
    Object.defineProperty(globalThis, key, { configurable: true, value: key === 'window' ? dom.window : dom.window[key] });
  }
  Object.defineProperty(globalThis, 'getComputedStyle', { configurable: true, value: dom.window.getComputedStyle.bind(dom.window) });
  Object.defineProperty(globalThis, 'requestAnimationFrame', { configurable: true, value: dom.window.requestAnimationFrame.bind(dom.window) });
  dom.window.Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  dom.window.Range.prototype.getBoundingClientRect = () => new dom.window.DOMRect();
  const { NephriteEditor } = await import('../ui/src/editor');
  const editor = new NephriteEditor(dom.window.document.body, { onDirty() {}, onSave() {}, onCursor() {}, onOpenWikilink() {} });
  try {
    editor.setDoc(source);
    editor.setCursor(source.indexOf('Left'));
    editor.view.contentDOM.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Tab', code: 'Tab', bubbles: true, cancelable: true }));
    assert.equal(selected(editor.view.state), 'Centered');
    editor.setVim(true);
    editor.setCursor(source.indexOf('Left'));
    editor.view.contentDOM.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'i', code: 'KeyI', bubbles: true, cancelable: true }));
    editor.view.contentDOM.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Tab', code: 'Tab', bubbles: true, cancelable: true }));
    assert.equal(selected(editor.view.state), 'Centered');
    editor.setVim(false);
    const broken = '| A | B |\n| one |';
    editor.setDoc(broken);
    assert.equal(openTableRepair(editor.view, broken.indexOf('one')), true);
    assert.equal(editor.getDoc(), broken);
    let panel = dom.window.document.querySelector('.cm-table-repair')!;
    assert.match(panel.textContent!, /Missing separator/);
    const buttons = panel.querySelectorAll('button');
    (buttons[1] as HTMLButtonElement).click();
    assert.equal(editor.getDoc(), broken);
    assert.equal(dom.window.document.querySelector('.cm-table-repair'), null);
    openTableRepair(editor.view, broken.indexOf('one'));
    panel = dom.window.document.querySelector('.cm-table-repair')!;
    (panel.querySelector('button') as HTMLButtonElement).click();
    assert.equal(editor.view.state.doc.lines, 3);
    assert.equal(dom.window.document.querySelector('.cm-table-repair'), null);
    undo(editor.view);
    assert.equal(editor.getDoc(), broken);
    openTableRepair(editor.view, broken.indexOf('one'));
    editor.view.dispatch({ changes: { from: broken.indexOf('one'), insert: 'x' }, userEvent: 'input.type' });
    assert.equal(dom.window.document.querySelector('.cm-table-repair'), null);
    assert.equal(applyTableRepair(editor.view), false);

    editor.setDoc(source);
    editor.setTableSettings({ ...DEFAULT_TABLE_SETTINGS, liveFormatting: false, padding: 3, wrapSource: true });
    assert.equal(editor.getDoc(), source);
    const one = source.indexOf('one');
    editor.view.dispatch({ changes: { from: one, insert: '!' }, userEvent: 'input.type' });
    assert.equal(editor.getDoc(), source.slice(0, one) + '!' + source.slice(one));
    editor.formatTables('note');
    assert.match(editor.getDoc(), /^\| {3}Left/);
    editor.setTableSettings(DEFAULT_TABLE_SETTINGS);

    editor.setDoc(source);
    assert.equal(beginCellSelection(editor.view, source.indexOf('one')), true);
    extendCellSelection(editor.view, 0, 1);
    assert.equal(selectedCellsTsv(editor.view.state), 'one\ttwo');
    let copied = '';
    const copy = new dom.window.Event('copy', { bubbles: true, cancelable: true });
    Object.defineProperty(copy, 'clipboardData', { value: { setData(_kind: string, text: string) { copied = text; } } });
    editor.view.contentDOM.dispatchEvent(copy);
    assert.equal(copied, 'one\ttwo');
    editor.view.contentDOM.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true }));
    assert.deepEqual(tableCells(editor.view.state.doc.line(3).text)!.slice(0, 2).map(cell => cell.text), ['', '']);
    undo(editor.view);
    assert.equal(editor.getDoc(), source);

    editor.setDoc('');
    const paste = new dom.window.Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(paste, 'clipboardData', { value: { files: [], getData(kind: string) { return kind === 'text/plain' ? 'Name\tRate\nAda\t120' : ''; } } });
    editor.view.contentDOM.dispatchEvent(paste);
    assert.equal(editor.getDoc(), '');
    const pastePanel = dom.window.document.querySelector('[aria-label="Spreadsheet paste proposal"]')!;
    assert.ok(pastePanel);
    (pastePanel.querySelector('button') as HTMLButtonElement).click();
    assert.equal(editor.view.state.doc.lines, 4);
    assert.deepEqual(tableCells(editor.view.state.doc.line(3).text)!.map(cell => cell.text), ['Ada', '120']);
    undo(editor.view);
    assert.equal(editor.getDoc(), '');

    const grid = clipboardGrid('<table><tr><th colspan="2">Merged</th></tr><tr><td>a<br>b</td><td>c</td></tr></table>', '');
    assert.deepEqual(grid, { cells: [['Merged', ''], ['a\nb', 'c']], merged: true });
  } finally {
    editor.destroy();
    dom.window.close();
  }
});

import { DEFAULT_TABLE_SETTINGS, normalizeTableSettings, loadTableSettings } from '../ui/src/table-settings';
import { clipboardGrid, parseTsv, spreadsheetCell } from '../ui/src/table-clipboard';
import { planTablePaste, applyTablePaste, showTablePaste, tablePasteState } from '../ui/src/table-paste';
import { beginCellSelection, extendCellSelection, selectedCellsTsv, cellRegionState, setCellRegion, regionCells } from '../ui/src/table-selection';

test('manual formatting covers existing tables and preserves alignment, order, and non-tables', () => {
  const doc = source + '\n\nparagraph\n\n| A | B |\n| --- | ---: |\n| z | 2 |\n| a | 1 |\n\n| Broken | Two |\n| --- | --- |\n| lone |\n\n```\n' + source + '\n```';
  let s = EditorState.create({ doc, extensions: [markdown(), history(), liveTableFormatting(() => false, () => ({ liveFormatting: false, padding: 2 }))] });
  const targets = tableFormatTargets(s, 'note');
  assert.equal(targets.ranges.length, 2);
  assert.equal(targets.skipped, 1);
  s = s.update({ effects: formatTableRanges.of(targets.ranges), userEvent: 'input.table.format' }).state;
  assert.deepEqual(tableAlignments(s.doc.line(2).text), ['left', 'center', 'right', null, 'justify']);
  assert.ok(s.doc.toString().indexOf('|  z') < s.doc.toString().indexOf('|  a'));
  assert.ok(s.doc.toString().endsWith('```\n' + source + '\n```'));
  const target = { get state() { return s; }, dispatch(t: Transaction) { s = t.state; } };
  undo(target);
  assert.equal(s.doc.toString(), doc);
  assert.deepEqual(tableFormatTargets(state(), 'selection').ranges, []);
});

test('table settings reject invalid values and survive stored-data failures', () => {
  assert.deepEqual(normalizeTableSettings(null), DEFAULT_TABLE_SETTINGS);
  assert.equal(normalizeTableSettings({ padding: 999, previewWidth: -1 }).padding, 4);
  assert.equal(normalizeTableSettings({ padding: NaN }).padding, 1);
  assert.deepEqual(loadTableSettings({ getItem: () => '{bad' }), DEFAULT_TABLE_SETTINGS);
  assert.equal(loadTableSettings({ getItem: () => '{"liveFormatting":false}' }).liveFormatting, false);
});

test('spreadsheet TSV parses quoted delimiters and multiline cells without interpreting ordinary prose', () => {
  assert.deepEqual(parseTsv('A\tB\r\n"a\tb"\t"line1\nline2"\r\n'), [['A', 'B'], ['a\tb', 'line1\nline2']]);
  assert.deepEqual(parseTsv('"He said ""hi"""\tx'), [['He said "hi"', 'x']]);
  assert.deepEqual(parseTsv('a\tb\n\t\n'), [['a', 'b'], ['', '']]);
  assert.equal(parseTsv('a,b\nx,y'), null);
  assert.equal(parseTsv('indented\n\tcode'), null);
  assert.equal(parseTsv('a\t"unclosed'), null);
  assert.equal(spreadsheetCell('a|b\n<script>'), 'a\\|b<br>&lt;script&gt;');
});

test('paste proposal expands the destination and counts overwritten cells before applying', () => {
  const doc = '| Name | Rate |\n| --- | ---: |\n| Ada | 120 |';
  let s = EditorState.create({ doc, extensions: [history(), tablePasteState, cellRegionState] });
  s = at(s, '120');
  const grid = { cells: [['125', 'active'], ['130', 'pending']], merged: false };
  const plan = planTablePaste(s, grid, '125\tactive\n130\tpending')!;
  assert.equal(s.doc.toString(), doc);
  assert.match(plan.summary, /Replaces 1 populated cells; adds 1 rows and 1 columns/);
  assert.deepEqual(tableAlignments(plan.after.split('\n')[1]), [null, 'right', null]);
  s = s.update({ effects: showTablePaste.of(plan) }).state;
  const view = { get state() { return s; }, dispatch(spec: any) { s = spec instanceof Transaction ? spec.state : s.update(spec).state; } };
  assert.equal(applyTablePaste(view), true);
  assert.deepEqual(tableCells(s.doc.line(3).text)!.map(cell => cell.text), ['Ada', '125', 'active']);
  undo(view);
  assert.equal(s.doc.toString(), doc);
  s = s.update({ effects: showTablePaste.of(plan), changes: { from: 0, insert: 'x' } }).state;
  assert.equal(applyTablePaste(view), false);
});

test('region selection excludes pipes and separator rows; paste anchors at the rectangle corner', () => {
  let s = EditorState.create({ doc: source, extensions: [cellRegionState] });
  s = s.update({ effects: setCellRegion.of({ first: 1, last: 3, columns: 5, anchorRow: 1, headRow: 0, anchorCol: 2, headCol: 1 }) }).state;
  assert.equal(selectedCellsTsv(s), 'Centered\tRight\ntwo\tthree');
  const region = s.field(cellRegionState)!;
  for (const cell of regionCells(s, region).flat()) assert.ok(!s.doc.sliceString(cell.from, cell.to).includes('|'));
  const plan = planTablePaste(s, { cells: [['C', 'R']], merged: false }, 'C\tR')!;
  assert.deepEqual(tableCells(plan.after.split('\n')[0])!.slice(0, 3).map(cell => cell.text), ['Left', 'C', 'R']);
  assert.match(plan.summary, /Selection is 2 × 2/);
});

test('source sorting is numeric, stable, keeps blanks last, and is fully undoable', () => {
  const doc = '| Name | Rate |\n| :--- | ---: |\n| a | 120 |\n| b | 9 |\n| c | 120 |\n| d | |';
  let s = state(doc);
  const plan = sortSourceTable(s, doc.indexOf('Rate'), 1)!;
  s = s.update(plan).state;
  assert.equal(s.doc.line(1).text, '| Name | Rate |');
  assert.equal(s.doc.line(2).text, '| :--- | ---: |');
  assert.deepEqual([3, 4, 5, 6].map(n => tableCells(s.doc.line(n).text)![0].text), ['b', 'a', 'c', 'd']);
  s = s.update(sortSourceTable(s, 10, -1)!).state;
  assert.deepEqual([3, 4, 5, 6].map(n => tableCells(s.doc.line(n).text)![0].text), ['a', 'c', 'b', 'd']);
  const view = { get state() { return s; }, dispatch(t: Transaction) { s = t.state; } };
  undo(view); undo(view);
  assert.equal(s.doc.toString(), doc);
});
