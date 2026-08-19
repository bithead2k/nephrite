import { uiAlert } from "./dialogs";

export type AppCommand = {
  id: string;
  title: string;
  keywords?: string;
  shortcut?: string;
  run: () => void | Promise<void>;
};

function commandScore(command: AppCommand, query: string): number {
  if (!query) return 1;
  const haystack = `${command.title} ${command.keywords || ""}`.toLowerCase();
  if (haystack.startsWith(query)) return 1000 - haystack.length;
  const direct = haystack.indexOf(query);
  if (direct >= 0) return 700 - direct;
  let cursor = 0;
  let gaps = 0;
  for (const character of query) {
    const found = haystack.indexOf(character, cursor);
    if (found < 0) return -1;
    gaps += found - cursor;
    cursor = found + 1;
  }
  return 400 - gaps;
}

export function filterCommands(commands: AppCommand[], rawQuery: string): AppCommand[] {
  const query = rawQuery.trim().toLowerCase();
  return commands
    .map((command, index) => ({ command, index, score: commandScore(command, query) }))
    .filter((candidate) => candidate.score >= 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map((candidate) => candidate.command);
}

export type CommandBarContext = {
  vault?: string;
  file?: string | null;
  mode?: string;
};

export type PersistentCommandBar = {
  focus: () => void;
  refresh: () => void;
};

export type CommandBarShellResult = {
  stdout: string;
  stderr: string;
  code: number;
  ok: boolean;
};

export type CommandBarShellExecutor = (
  command: string,
) => Promise<CommandBarShellResult>;

/** A leading bang switches the persistent prompt from search to shell mode. */
export function bangShellCommand(raw: string): string | null {
  if (!raw.startsWith("!")) return null;
  return raw.slice(1).trim();
}

/**
 * Mount the application command prompt in permanent chrome. Unlike the modal
 * palette, this prompt never represents editor state: its Powerline segments
 * identify the application and the command interface itself.
 */
export function renderPersistentCommandBar(
  host: HTMLElement,
  commands: () => AppCommand[],
  executeShell?: CommandBarShellExecutor,
): PersistentCommandBar {
  host.replaceChildren();
  host.classList.add("command-bar", "persistent-command-bar");

  const results = document.createElement("div");
  results.className = "command-bar-results persistent-command-results";
  results.hidden = true;

  const row = document.createElement("div");
  row.className = "persistent-command-row";
  const prompt = document.createElement("button");
  prompt.type = "button";
  prompt.className = "command-bar-powerline persistent-command-prompt";
  prompt.title = "Focus command prompt";
  prompt.setAttribute("aria-label", "Focus command prompt");
  for (const [index, text] of ["NEPHRITE", "COMMAND"].entries()) {
    const segment = document.createElement("span");
    segment.className = `command-bar-segment command-bar-segment-${index}`;
    segment.textContent = text;
    prompt.appendChild(segment);
  }

  const input = document.createElement("input");
  input.type = "search";
  input.className = "command-bar-input persistent-command-input";
  input.placeholder = "Type a command, note name, or ! shell command…";
  input.autocomplete = "off";
  input.setAttribute("aria-label", "Nephrite command prompt");
  row.append(prompt, input);
  host.append(results, row);

  let catalog: AppCommand[] = [];
  let matches: AppCommand[] = [];
  let active = 0;
  let open = false;

  const hide = () => {
    open = false;
    results.hidden = true;
    results.replaceChildren();
  };
  const run = (command: AppCommand) => {
    input.value = "";
    hide();
    input.blur();
    void Promise.resolve(command.run()).catch((error) => void uiAlert(String(error)));
  };
  const drawShellOutput = (result: CommandBarShellResult) => {
    results.replaceChildren();
    const output = document.createElement("pre");
    output.className = `command-bar-shell-output${result.ok ? "" : " error"}`;
    const streams = [result.stdout.trimEnd(), result.stderr.trimEnd()].filter(Boolean);
    output.textContent = streams.join("\n") || `(exit ${result.code}, no output)`;
    if (!result.ok) output.textContent += `\n[exit ${result.code}]`;
    results.appendChild(output);
    results.hidden = false;
  };
  const runShell = async (command: string) => {
    if (!executeShell || !command) return;
    input.value = "";
    matches = [];
    active = 0;
    results.innerHTML = '<div class="feature-loading">Running shell command…</div>';
    results.hidden = false;
    input.focus();
    try {
      drawShellOutput(await executeShell(command));
    } catch (error) {
      drawShellOutput({ stdout: "", stderr: String(error), code: -1, ok: false });
    }
  };
  const draw = () => {
    if (!open) return;
    const shellCommand = bangShellCommand(input.value);
    if (shellCommand !== null) {
      matches = [];
      active = 0;
      results.replaceChildren();
      if (!executeShell) {
        results.innerHTML = '<div class="feature-empty">Shell execution is unavailable.</div>';
      } else if (!shellCommand) {
        results.innerHTML = '<div class="feature-empty">Enter shell code after !</div>';
      } else {
        const command = shellCommand;
        results.appendChild(commandResult({
          id: "shell",
          title: `Run shell: ${command}`,
          shortcut: "Enter",
          run: () => runShell(command),
        }, 0, 0, () => {}, () => void runShell(command)));
      }
      results.hidden = false;
      return;
    }
    matches = filterCommands(catalog, input.value).slice(0, 80);
    active = Math.max(0, Math.min(active, matches.length - 1));
    results.replaceChildren();
    for (const [index, command] of matches.entries()) {
      const button = commandResult(command, index, active, () => {
        active = index;
        results.querySelector(".active")?.classList.remove("active");
        button.classList.add("active");
      }, () => run(command));
      results.appendChild(button);
    }
    if (!matches.length) results.innerHTML = '<div class="feature-empty">No matching command.</div>';
    results.hidden = false;
  };
  const refresh = () => {
    catalog = commands();
    if (open) draw();
  };
  const focus = () => {
    refresh();
    open = true;
    active = 0;
    draw();
    input.focus();
    input.select();
  };

  prompt.addEventListener("click", focus);
  input.addEventListener("focus", () => {
    if (!open) focus();
  });
  input.addEventListener("input", () => { active = 0; draw(); });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      input.value = "";
      hide();
      input.blur();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (matches.length) active = (active + (event.key === "ArrowDown" ? 1 : -1) + matches.length) % matches.length;
      draw();
      results.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
    } else if (event.key === "Enter" && bangShellCommand(input.value) !== null) {
      event.preventDefault();
      const command = bangShellCommand(input.value);
      if (command) void runShell(command);
    } else if (event.key === "Enter" && matches[active]) {
      event.preventDefault();
      run(matches[active]);
    }
  });
  host.addEventListener("focusout", () => {
    window.setTimeout(() => {
      if (!host.contains(document.activeElement)) hide();
    }, 0);
  });

  return { focus, refresh };
}

function commandResult(
  command: AppCommand,
  index: number,
  active: number,
  activate: () => void,
  run: () => void,
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `command-bar-result${index === active ? " active" : ""}`;
  button.dataset.index = String(index);
  const title = document.createElement("span");
  title.textContent = command.title;
  const shortcut = document.createElement("kbd");
  shortcut.textContent = command.shortcut || "";
  button.append(title, shortcut);
  button.addEventListener("mousemove", activate);
  button.addEventListener("click", run);
  return button;
}

export function renderCommandBar(
  host: HTMLElement,
  commands: AppCommand[],
  close: () => void,
  context: CommandBarContext = {},
) {
  host.replaceChildren();
  host.classList.add("command-bar");
  const prompt = document.createElement("div");
  prompt.className = "command-bar-powerline";
  prompt.setAttribute("aria-hidden", "true");
  const segments = [
    context.vault || "vault",
    context.file || "no-file",
    context.mode || "source",
  ];
  for (const [index, text] of segments.entries()) {
    const segment = document.createElement("span");
    segment.className = `command-bar-segment command-bar-segment-${index}`;
    segment.textContent = text;
    prompt.appendChild(segment);
  }
  const input = document.createElement("input");
  input.type = "search";
  input.className = "command-bar-input";
  input.placeholder = "Type a command or note name…";
  input.autocomplete = "off";
  const list = document.createElement("div");
  list.className = "command-bar-results";
  host.append(prompt, input, list);
  let matches = commands;
  let active = 0;

  const run = (command: AppCommand) => {
    close();
    void Promise.resolve(command.run()).catch((error) => void uiAlert(String(error)));
  };
  const draw = () => {
    matches = filterCommands(commands, input.value).slice(0, 80);
    active = Math.max(0, Math.min(active, matches.length - 1));
    list.replaceChildren();
    for (const [index, command] of matches.entries()) {
      const button = commandResult(command, index, active, () => {
        active = index;
        list.querySelector(".active")?.classList.remove("active");
        button.classList.add("active");
      }, () => run(command));
      list.appendChild(button);
    }
    if (!matches.length) list.innerHTML = '<div class="feature-empty">No matching command.</div>';
  };
  input.addEventListener("input", () => { active = 0; draw(); });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (matches.length) active = (active + (event.key === "ArrowDown" ? 1 : -1) + matches.length) % matches.length;
      draw();
      list.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
    } else if (event.key === "Enter" && matches[active]) {
      event.preventDefault();
      run(matches[active]);
    }
  });
  draw();
  requestAnimationFrame(() => input.focus());
}
