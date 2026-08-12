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

export function renderCommandBar(
  host: HTMLElement,
  commands: AppCommand[],
  close: () => void,
) {
  host.replaceChildren();
  host.classList.add("command-bar");
  const input = document.createElement("input");
  input.type = "search";
  input.className = "command-bar-input";
  input.placeholder = "Type a command or note name…";
  input.autocomplete = "off";
  const list = document.createElement("div");
  list.className = "command-bar-results";
  host.append(input, list);
  let matches = commands;
  let active = 0;

  const run = (command: AppCommand) => {
    close();
    void Promise.resolve(command.run()).catch((error) => window.alert(String(error)));
  };
  const draw = () => {
    matches = filterCommands(commands, input.value).slice(0, 80);
    active = Math.max(0, Math.min(active, matches.length - 1));
    list.replaceChildren();
    for (const [index, command] of matches.entries()) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `command-bar-result${index === active ? " active" : ""}`;
      button.dataset.index = String(index);
      const title = document.createElement("span");
      title.textContent = command.title;
      const shortcut = document.createElement("kbd");
      shortcut.textContent = command.shortcut || "";
      button.append(title, shortcut);
      button.addEventListener("mousemove", () => {
        active = index;
        list.querySelector(".active")?.classList.remove("active");
        button.classList.add("active");
      });
      button.addEventListener("click", () => run(command));
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
