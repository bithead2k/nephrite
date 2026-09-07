import { showItemMenu } from "./context-menu";

export const PRINT_PREVIEW_LABEL = "Print current document…";

/**
 * Bind a native-feeling context menu to a rendered preview. The path is kept on
 * the element because preview roots are reused as the user switches notes.
 */
export function bindPreviewPrintMenu(
  root: HTMLElement,
  path: string,
  onPrint: (root: HTMLElement, path: string) => void,
): void {
  root.dataset.printPath = path;
  if (root.dataset.printMenuBound === "1") return;
  root.dataset.printMenuBound = "1";
  root.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    event.stopPropagation();
    showItemMenu(
      event.clientX,
      event.clientY,
      [{ id: "print-document", label: PRINT_PREVIEW_LABEL }],
      (id) => {
        if (id === "print-document") {
          onPrint(root, root.dataset.printPath ?? "");
        }
      },
    );
  });
}

export type PrintablePreviewOptions = {
  includeFrontmatter?: boolean;
};

type Rgb = { r: number; g: number; b: number; a: number };

const PAPER: Rgb = { r: 255, g: 255, b: 255, a: 1 };

/** Snapshot and color-correct the live preview rather than re-rendering Markdown. */
export function printablePreviewHtml(
  root: HTMLElement,
  options: PrintablePreviewOptions = {},
): string {
  const clone = root.cloneNode(true) as HTMLElement;
  const properties = clone.querySelectorAll<HTMLDetailsElement>("details.props-block");
  if (options.includeFrontmatter) {
    properties.forEach((details) => { details.open = true; });
  } else {
    properties.forEach((details) => details.remove());
  }
  clone.querySelectorAll<HTMLInputElement>("input").forEach((input) => {
    if (input.checked) input.setAttribute("checked", "");
    else input.removeAttribute("checked");
    input.setAttribute("value", input.value);
  });
  clone.querySelectorAll<HTMLTextAreaElement>("textarea").forEach((area) => {
    area.textContent = area.value;
  });
  clone.querySelectorAll<HTMLElement>(".hidden").forEach((element) => element.remove());
  return clone.innerHTML;
}

/**
 * Translate the computed screen theme into a paper palette. Hues survive, but
 * dark panels become pale tints and low-contrast text is darkened just enough
 * to remain legible. Images, emoji, and SVG artwork are left intact.
 */
export function normalizePrintColors(source: HTMLElement, clone: HTMLElement): void {
  const view = source.ownerDocument.defaultView;
  if (!view) return;
  const sources = [source, ...source.querySelectorAll<HTMLElement>("*")];
  const clones = [clone, ...clone.querySelectorAll<HTMLElement>("*")];
  const count = Math.min(sources.length, clones.length);
  const measurements = sources.slice(0, count).map((original) => {
    if (original.closest("svg") || original.namespaceURI === "http://www.w3.org/2000/svg") {
      return null;
    }
    const computed = view.getComputedStyle(original);
    return {
      color: computed.color,
      backgroundColor: computed.backgroundColor,
      backgroundImage: computed.backgroundImage,
      boxShadow: computed.boxShadow,
      opacity: computed.opacity,
    };
  });
  for (let index = 0; index < count; index++) {
    const copy = clones[index];
    const computed = measurements[index];
    if (!computed) continue;
    const background = paperBackground(computed.backgroundColor);
    const foreground = accessiblePrintColor(computed.color, background);
    if (foreground) copy.style.setProperty("color", foreground, "important");
    const parsedBackground = parseRgb(computed.backgroundColor);
    if (parsedBackground && parsedBackground.a > 0.01) {
      copy.style.setProperty("background-color", rgbCss(background), "important");
    }
    if (computed.backgroundImage && computed.backgroundImage !== "none") {
      copy.style.setProperty("background-image", "none", "important");
    }
    if (computed.boxShadow && computed.boxShadow !== "none") {
      copy.style.setProperty("box-shadow", "none", "important");
    }
    if (Number(computed.opacity) < 1) copy.style.setProperty("opacity", "1", "important");
  }
}

export function accessiblePrintColor(color: string, background: Rgb = PAPER): string | null {
  const parsed = parseRgb(color);
  if (!parsed || parsed.a <= 0.01) return null;
  const foreground = composite(parsed, background);
  if (contrastRatio(foreground, background) >= 4.5) return rgbCss(foreground);
  let low = 0;
  let high = 1;
  for (let step = 0; step < 16; step++) {
    const amount = (low + high) / 2;
    const candidate = mix(foreground, { r: 0, g: 0, b: 0, a: 1 }, amount);
    if (contrastRatio(candidate, background) >= 4.5) high = amount;
    else low = amount;
  }
  return rgbCss(mix(foreground, { r: 0, g: 0, b: 0, a: 1 }, high));
}

function paperBackground(color: string): Rgb {
  const parsed = parseRgb(color);
  if (!parsed || parsed.a <= 0.01) return PAPER;
  const opaque = composite(parsed, PAPER);
  if (relativeLuminance(opaque) >= 0.82) return opaque;
  let low = 0;
  let high = 1;
  for (let step = 0; step < 16; step++) {
    const amount = (low + high) / 2;
    const candidate = mix(opaque, PAPER, amount);
    if (relativeLuminance(candidate) >= 0.9) high = amount;
    else low = amount;
  }
  return mix(opaque, PAPER, high);
}

function parseRgb(color: string): Rgb | null {
  const match = color.match(/^rgba?\(\s*([\d.]+)[, ]+([\d.]+)[, ]+([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)$/i);
  if (!match) return null;
  return {
    r: Math.max(0, Math.min(255, Number(match[1]))),
    g: Math.max(0, Math.min(255, Number(match[2]))),
    b: Math.max(0, Math.min(255, Number(match[3]))),
    a: match[4] == null ? 1 : Math.max(0, Math.min(1, Number(match[4]))),
  };
}

function composite(foreground: Rgb, background: Rgb): Rgb {
  const alpha = foreground.a + background.a * (1 - foreground.a);
  if (alpha <= 0) return { ...PAPER };
  return {
    r: (foreground.r * foreground.a + background.r * background.a * (1 - foreground.a)) / alpha,
    g: (foreground.g * foreground.a + background.g * background.a * (1 - foreground.a)) / alpha,
    b: (foreground.b * foreground.a + background.b * background.a * (1 - foreground.a)) / alpha,
    a: alpha,
  };
}

function mix(from: Rgb, to: Rgb, amount: number): Rgb {
  return {
    r: from.r + (to.r - from.r) * amount,
    g: from.g + (to.g - from.g) * amount,
    b: from.b + (to.b - from.b) * amount,
    a: 1,
  };
}

function relativeLuminance(color: Rgb): number {
  const channel = (value: number) => {
    const normalized = value / 255;
    return normalized <= 0.04045
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
}

function contrastRatio(a: Rgb, b: Rgb): number {
  const light = Math.max(relativeLuminance(a), relativeLuminance(b));
  const dark = Math.min(relativeLuminance(a), relativeLuminance(b));
  return (light + 0.05) / (dark + 0.05);
}

function rgbCss(color: Rgb): string {
  return `rgb(${Math.round(color.r)}, ${Math.round(color.g)}, ${Math.round(color.b)})`;
}

export function previewPrintTitle(path: string): string {
  return path.split("/").pop()?.replace(/\.(?:md|markdown)$/i, "") || path || "note";
}

export type StagedPrintDocument = {
  root: HTMLElement;
  cleanup: () => void;
};

export const PRINT_PAGE_CSS = `
@page { margin: 0.5in 0; }
@media print {
  html, body, .nephrite-print-stage { font-size: 10pt !important; }
  .nephrite-print-stage {
    box-sizing: border-box !important;
    padding-left: 0.5in !important;
    padding-right: 0.5in !important;
  }
}`;

/**
 * Stage print content in the top-level document. WebKit desktop webviews ignore
 * print() on hidden child frames, but route a top-level print() to the native
 * print system.
 */
export function stagePrintDocument(
  document: Document,
  title: string,
  bodyHtml: string,
  css: string,
): StagedPrintDocument {
  const previousTitle = document.title;
  const style = document.createElement("style");
  style.dataset.nephritePrintStage = "1";
  style.textContent = `${css}

${PRINT_PAGE_CSS}

.nephrite-print-stage { display: none !important; }
@media print {
  html, body { height: auto !important; overflow: visible !important; }
  body.nephrite-printing > *:not(.nephrite-print-stage) { display: none !important; }
  body.nephrite-printing > .nephrite-print-stage {
    display: block !important;
    position: static !important;
    width: auto !important;
    height: auto !important;
    overflow: visible !important;
    color-scheme: light !important;
    --bg: #fff;
    --bg-elevated: #fff;
    --text: #18211f;
    --muted: #4d5d58;
    --accent: #176b55;
    --border: #9caaa6;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
}`;
  const root = document.createElement("article");
  root.className = "nephrite-print-stage preview print-export";
  root.dataset.nephritePrintStage = "1";
  root.innerHTML = bodyHtml;
  document.title = title;
  document.head.appendChild(style);
  document.body.appendChild(root);
  document.body.classList.add("nephrite-printing");
  normalizePrintColors(root, root);
  applyPaperComponentDefaults(root);

  let active = true;
  return {
    root,
    cleanup: () => {
      if (!active) return;
      active = false;
      root.remove();
      style.remove();
      document.body.classList.remove("nephrite-printing");
      document.title = previousTitle;
    },
  };
}

function applyPaperComponentDefaults(root: HTMLElement): void {
  root.querySelectorAll<HTMLElement>("table tbody tr:nth-child(odd) > th, table tbody tr:nth-child(odd) > td")
    .forEach((cell) => cell.style.setProperty("background-color", "#ffffff", "important"));
  root.querySelectorAll<HTMLElement>("table tbody tr:nth-child(even) > th, table tbody tr:nth-child(even) > td")
    .forEach((cell) => cell.style.setProperty("background-color", "#f1f4f3", "important"));

  // Callout meaning remains in its border and icon; the reading surface stays paper-white.
  root.querySelectorAll<HTMLElement>(".callout, .callout-title, .callout-content")
    .forEach((element) => element.style.setProperty("background-color", "#ffffff", "important"));
  root.querySelectorAll<HTMLElement>(".callout-title")
    .forEach((title) => {
      const readable = accessiblePrintColor(
        title.ownerDocument.defaultView?.getComputedStyle(title).color ?? "rgb(24, 33, 31)",
      );
      if (readable) title.style.setProperty("color", readable, "important");
      title.style.setProperty("font-weight", "650", "important");
    });
}
