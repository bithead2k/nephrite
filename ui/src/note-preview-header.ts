export function createNotePreviewHeader(options: {
  className: string;
  title: string;
  path: string;
  onOpen: () => void;
}): HTMLElement {
  const head = document.createElement("div");
  head.className = `${options.className} note-preview-head`;
  head.title = options.path;

  const label = document.createElement("span");
  label.className = "note-preview-head-title";
  label.textContent = options.title;

  const openButton = document.createElement("button");
  openButton.type = "button";
  openButton.className = "note-preview-open-button";
  openButton.innerHTML = [
    '<svg class="note-preview-open-icon" viewBox="0 0 24 24" aria-hidden="true"',
    ' fill="none" stroke="currentColor" stroke-width="1.8"',
    ' stroke-linecap="round" stroke-linejoin="round">',
    '<rect x="3.5" y="3.5" width="17" height="17" rx="2"/>',
    '<path d="M8 16 16 8M11.5 8H16v4.5M12.5 16H8v-4.5"/>',
    "</svg>",
  ].join("");
  openButton.title = `Open ${options.title} in editor`;
  openButton.setAttribute("aria-label", `Open ${options.title} in editor`);
  openButton.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    options.onOpen();
  });

  head.append(label, openButton);
  return head;
}
