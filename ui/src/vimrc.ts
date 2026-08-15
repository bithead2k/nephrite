export type VimrcEditorSettings = {
  lineNumbers: boolean;
  relativeLineNumbers: boolean;
  expandTab: boolean;
  tabSize: number;
  shiftWidth: number;
  cursorLine: boolean;
  showStatus: boolean;
  fontSize: number | null;
  fontFamily: string | null;
  colorColumns: number[];
  runtimePaths: string[];
  mswin: boolean;
  airlineTheme: string | null;
  airlinePowerlineFonts: boolean;
};

export type ParsedVimrc = {
  commands: string[];
  abbreviations: Array<{ lhs: string; rhs: string }>;
  userCommands: Array<{ name: string; command: string }>;
  settings: VimrcEditorSettings;
  appliedSettings: number;
  skipped: Array<{ line: number; source: string }>;
};

const MAP_COMMANDS = new Set([
  "map", "nmap", "imap", "vmap", "omap",
  "noremap", "nnoremap", "inoremap", "vnoremap", "onoremap",
  "unmap", "mapclear", "nmapclear", "imapclear", "vmapclear", "omapclear",
]);

export function parseVimrc(content: string): ParsedVimrc {
  const settings: VimrcEditorSettings = {
    lineNumbers: true,
    relativeLineNumbers: false,
    expandTab: true,
    tabSize: 4,
    shiftWidth: 2,
    cursorLine: true,
    showStatus: false,
    fontSize: null,
    fontFamily: null,
    colorColumns: [],
    runtimePaths: [],
    mswin: false,
    airlineTheme: null,
    airlinePowerlineFonts: false,
  };
  const commands: string[] = [];
  const abbreviations: Array<{ lhs: string; rhs: string }> = [];
  const userCommands: Array<{ name: string; command: string }> = [];
  const skipped: Array<{ line: number; source: string }> = [];
  let appliedSettings = 0;
  let leader = "\\";
  let localLeader = "\\";
  let finished = false;
  const variables = new Map<string, string | number>();
  const conditionals: Array<{ parent: boolean; active: boolean; matched: boolean }> = [];
  const isActive = () => conditionals.every((conditional) => conditional.active);

  const lines = joinContinuations(content);
  for (const { line, source } of lines) {
    if (finished) break;
    let command = source.trim();
    if (!command || command.startsWith('"')) continue;
    if (command.startsWith(":")) command = command.slice(1).trimStart();

    const ifMatch = command.match(/^if\s+(.+)$/i);
    if (ifMatch) {
      const parent = isActive();
      const value = parent && evaluateCondition(ifMatch[1], variables);
      conditionals.push({ parent, active: value, matched: value });
      continue;
    }
    const elseifMatch = command.match(/^elseif\s+(.+)$/i);
    if (elseifMatch) {
      const current = conditionals.at(-1);
      if (!current) { skipped.push({ line, source }); continue; }
      current.active = current.parent && !current.matched && evaluateCondition(elseifMatch[1], variables);
      current.matched ||= current.active;
      continue;
    }
    if (/^else\s*$/i.test(command)) {
      const current = conditionals.at(-1);
      if (!current) { skipped.push({ line, source }); continue; }
      current.active = current.parent && !current.matched;
      current.matched = true;
      continue;
    }
    if (/^endif\s*$/i.test(command)) {
      if (!conditionals.pop()) skipped.push({ line, source });
      continue;
    }
    if (!isActive()) continue;
    if (/^finish\s*$/i.test(command)) { finished = true; continue; }

    if (isHarmlessNoop(command)) {
      appliedSettings++;
      continue;
    }

    command = command.replace(/^(?:silent!?|keepjumps|keepalt|keeppatterns)\s+/i, "");
    const execute = command.match(/^execute\s+(.+)$/i);
    if (execute) {
      const evaluated = evaluateStringExpression(execute[1], variables);
      if (evaluated == null) { skipped.push({ line, source }); continue; }
      command = evaluated.trim();
    }

    const letMatch = command.match(/^let\s+([A-Za-z][\w:#]*)\s*=\s*(.+)$/i);
    if (letMatch) {
      const value = evaluateVimValue(letMatch[2], variables);
      if (value == null) { skipped.push({ line, source }); continue; }
      variables.set(letMatch[1].toLowerCase(), value);
      if (/^(?:g:)?mapleader$/i.test(letMatch[1])) leader = String(value);
      else if (/^(?:g:)?maplocalleader$/i.test(letMatch[1])) localLeader = String(value);
      else if (/^g:airline_theme$/i.test(letMatch[1])) settings.airlineTheme = String(value);
      else if (/^g:airline_powerline_fonts$/i.test(letMatch[1])) settings.airlinePowerlineFonts = Number(value) !== 0;
      appliedSettings++;
      continue;
    }
    const unletMatch = command.match(/^unlet!?\s+(.+)$/i);
    if (unletMatch) {
      for (const name of unletMatch[1].split(/\s+/)) variables.delete(name.toLowerCase());
      appliedSettings++;
      continue;
    }

    if (/^behave\s+mswin\s*$/i.test(command)) {
      settings.mswin = true;
      appliedSettings++;
      continue;
    }

    const name = command.match(/^[A-Za-z]+/)?.[0].toLowerCase() || "";
    if (MAP_COMMANDS.has(name)) {
      commands.push(command.replace(/<leader>/gi, leader).replace(/<localleader>/gi, localLeader));
      continue;
    }

    const userCommand = command.match(/^command!?\s+(?:-nargs=0\s+)?([A-Z][A-Za-z0-9]*)\s+(.+)$/);
    if (userCommand) {
      userCommands.push({ name: userCommand[1], command: userCommand[2] });
      continue;
    }

    const abbreviation = command.match(/^(?:iabbrev|iab|inoreabbrev)\s+(\S+)\s+(.+)$/i);
    if (abbreviation) {
      abbreviations.push({ lhs: abbreviation[1], rhs: abbreviation[2] });
      continue;
    }

    if (name === "set" || name === "setlocal" || name === "setglobal") {
      const prefix = name;
      const args = splitVimWords(command.slice(name.length).trim());
      for (const arg of args) {
        if (applyEditorOption(arg, settings)) {
          appliedSettings++;
        } else if (isVimCoreOption(arg)) {
          commands.push(`${prefix} ${arg}`);
          appliedSettings++;
        } else {
          skipped.push({ line, source: `${prefix} ${arg}` });
        }
      }
      continue;
    }

    // Full Vimscript, plugins, abbreviations, autocmds, and :source are not
    // safe or meaningful in the embedded CM6 Vim runtime.
    skipped.push({ line, source });
  }

  if (conditionals.length) skipped.push({ line: lines.at(-1)?.line ?? 1, source: "unterminated :if" });
  return { commands, abbreviations, userCommands, settings, appliedSettings, skipped };
}

function evaluateVimValue(expression: string, variables: Map<string, string | number>): string | number | null {
  const source = expression.trim();
  const quoted = source.match(/^(['"])([\s\S]*)\1$/);
  if (quoted) return quoted[2].replace(/\\(['"\\])/g, "$1");
  if (/^-?\d+(?:\.\d+)?$/.test(source)) return Number(source);
  return variables.get(source.toLowerCase()) ?? null;
}

function evaluateStringExpression(expression: string, variables: Map<string, string | number>): string | null {
  const parts = expression.split(/\s+\.\s+/);
  const values = parts.map((part) => evaluateVimValue(part, variables));
  return values.some((value) => value == null) ? null : values.map(String).join("");
}

function evaluateCondition(expression: string, variables: Map<string, string | number>): boolean {
  const source = expression.trim();
  const or = source.split(/\s*\|\|\s*/);
  if (or.length > 1) return or.some((part) => evaluateCondition(part, variables));
  const and = source.split(/\s*&&\s*/);
  if (and.length > 1) return and.every((part) => evaluateCondition(part, variables));
  if (source.startsWith("!")) return !evaluateCondition(source.slice(1), variables);
  const has = source.match(/^has\((['"])(.*?)\1\)$/i);
  if (has) return ["gui_running", "gui", "vim_starting", "clipboard"].includes(has[2].toLowerCase());
  const exists = source.match(/^exists\((['"])(.*?)\1\)$/i);
  if (exists) {
    const name = exists[2].toLowerCase();
    if (name.startsWith("+")) return ["number", "relativenumber", "expandtab", "tabstop", "shiftwidth", "colorcolumn", "guifont"].includes(name.slice(1));
    return variables.has(name.replace(/^\*/, ""));
  }
  const comparison = source.match(/^(.+?)\s*(==#?|!=#?)\s*(.+)$/);
  if (comparison) {
    const left = evaluateVimValue(comparison[1], variables);
    const right = evaluateVimValue(comparison[3], variables);
    const equal = String(left ?? "") === String(right ?? "");
    return comparison[2].startsWith("!=") ? !equal : equal;
  }
  const value = evaluateVimValue(source, variables);
  return typeof value === "number" ? value !== 0 : Boolean(value);
}

function applyEditorOption(raw: string, settings: VimrcEditorSettings): boolean {
  const arg = raw.toLowerCase();
  if (["nu", "number"].includes(arg)) settings.lineNumbers = true;
  else if (["nonu", "nonumber"].includes(arg)) settings.lineNumbers = false;
  else if (["rnu", "relativenumber"].includes(arg)) settings.relativeLineNumbers = true;
  else if (["nornu", "norelativenumber"].includes(arg)) settings.relativeLineNumbers = false;
  else if (["et", "expandtab"].includes(arg)) settings.expandTab = true;
  else if (["noet", "noexpandtab"].includes(arg)) settings.expandTab = false;
  else if (["cul", "cursorline"].includes(arg)) settings.cursorLine = true;
  else if (["nocul", "nocursorline"].includes(arg)) settings.cursorLine = false;
  else if (["sc", "showcmd", "ru", "ruler"].includes(arg)) settings.showStatus = true;
  else if (["nosc", "noshowcmd"].includes(arg)) settings.showStatus = false;
  else if (["smarttab", "sta", "nosmarttab", "nosta"].includes(arg)) return true;
  else {
    const assignment = raw.match(/^([^+^=\-]+)(\+=|\^=|-=|=)(.*)$/);
    if (!assignment) return false;
    const option = assignment[1].toLowerCase();
    const operator = assignment[2];
    const value = assignment[3];
    const number = Number(value);
    if (["tabstop", "ts"].includes(option) && operator === "=" && validWidth(number)) settings.tabSize = number;
    else if (["shiftwidth", "sw"].includes(option) && operator === "=" && validWidth(number)) settings.shiftWidth = number;
    else if (["colorcolumn", "cc"].includes(option)) {
      const columns = value
        .split(",")
        .map((part) => Number(part))
        .filter((column) => Number.isInteger(column) && column >= 1 && column <= 500);
      if (columns.length === 0 && value !== "") return false;
      if (operator === "+=") settings.colorColumns = [...new Set([...settings.colorColumns, ...columns])];
      else if (operator === "^=") settings.colorColumns = [...new Set([...columns, ...settings.colorColumns])];
      else if (operator === "-=") settings.colorColumns = settings.colorColumns.filter((column) => !columns.includes(column));
      else settings.colorColumns = [...new Set(columns)];
    }
    else if (["runtimepath", "rtp"].includes(option)) {
      const paths = value ? splitVimList(value) : [];
      if (operator === "+=") settings.runtimePaths.push(...paths);
      else if (operator === "^=") settings.runtimePaths.unshift(...paths);
      else if (operator === "-=") settings.runtimePaths = settings.runtimePaths.filter((path) => !paths.includes(path));
      else settings.runtimePaths = paths;
    }
    else if (["guifont", "gfn"].includes(option) && operator === "=") {
      const sizeMatch = value.match(/(?:\s|:h)(\d+(?:\.\d+)?)$/i);
      const size = Number(sizeMatch?.[1]);
      if (!Number.isFinite(size) || size < 8 || size > 72) return false;
      settings.fontSize = size;
      const family = value.slice(0, sizeMatch?.index).trim().replace(/_/g, " ");
      settings.fontFamily = family || null;
    } else return false;
  }
  return true;
}

function splitVimList(value: string): string[] {
  const entries: string[] = [];
  let entry = "";
  let escaped = false;
  for (const character of value) {
    if (escaped) {
      entry += character;
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (character === ",") {
      if (entry) entries.push(entry);
      entry = "";
    } else {
      entry += character;
    }
  }
  if (escaped) entry += "\\";
  if (entry) entries.push(entry);
  return entries;
}

function isHarmlessNoop(command: string): boolean {
  return /^(?:syntax\s+on|filetype(?:\s+plugin)?(?:\s+indent)?\s+on|colorscheme\s+\S+|highlight\b|hi\s+|autocmd\b|au\s+|augroup\b|runtime\b|source\s+|so\s+|packadd\b|set(?:local|global)?\s+(?:nocompatible|compatible|encoding=.+|fileencoding=.+|termguicolors|hidden|mouse=.+|ttimeout(?:len=.+)?|updatetime=.+|laststatus=.+|showmode|noshowmode|wildmenu|nowrap|wrap|linebreak|splitbelow|splitright|ignorecase|smartcase|incsearch|hlsearch|nohlsearch|backup|nobackup|writebackup|swapfile|noswapfile|undofile)|let\s+g:loaded_)/i.test(command);
}

function isVimCoreOption(raw: string): boolean {
  const option = raw.replace(/^no/, "").split(/[=!?]/, 1)[0].toLowerCase();
  return ["textwidth", "tw", "pcre", "insertmodeesckeystimeout", "langmap", "lmap"].includes(option);
}

function validWidth(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 32;
}

function splitVimWords(value: string): string[] {
  const words: string[] = [];
  let word = "";
  let escaped = false;
  for (const char of value) {
    if (escaped) {
      word += char;
      escaped = false;
    } else if (char === "\\") {
      escaped = true;
    } else if (/\s/.test(char)) {
      if (word) words.push(word);
      word = "";
    } else {
      word += char;
    }
  }
  if (escaped) word += "\\";
  if (word) words.push(word);
  return words;
}

function joinContinuations(content: string): Array<{ line: number; source: string }> {
  const result: Array<{ line: number; source: string }> = [];
  for (const [index, raw] of content.replace(/\r\n?/g, "\n").split("\n").entries()) {
    if (/^\s*\\/.test(raw) && result.length > 0) {
      result[result.length - 1].source += ` ${raw.replace(/^\s*\\\s?/, "")}`;
    } else {
      result.push({ line: index + 1, source: raw });
    }
  }
  return result;
}
