export type CanvasNode = {
  id: string;
  type: "text" | "file" | "link" | "group";
  x: number;
  y: number;
  width: number;
  height: number;
  text?: string;
  file?: string;
  url?: string;
  label?: string;
  color?: string;
  [key: string]: unknown;
};

export type CanvasEdge = {
  id: string;
  fromNode: string;
  toNode: string;
  fromSide?: string;
  toSide?: string;
  label?: string;
  color?: string;
  [key: string]: unknown;
};

export type CanvasDocument = {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  [key: string]: unknown;
};

export function parseCanvas(source: string): CanvasDocument {
  const parsed = JSON.parse(source) as Partial<CanvasDocument>;
  if (!parsed || !Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) {
    throw new Error("Canvas must contain nodes and edges arrays");
  }
  return { ...parsed, nodes: parsed.nodes as CanvasNode[], edges: parsed.edges as CanvasEdge[] };
}

export function serializeCanvas(document: CanvasDocument): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

function id(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export class CanvasView {
  private document: CanvasDocument | null = null;
  private selected: string | null = null;
  private connectingFrom: string | null = null;
  private readonly stage = document.createElement("div");
  private readonly edges = document.createElementNS("http://www.w3.org/2000/svg", "svg");

  constructor(
    host: HTMLElement,
    private readonly onChange: (source: string) => void,
    private readonly onOpenFile: (path: string) => void,
    private readonly onOpenUrl: (url: string) => void,
  ) {
    host.classList.add("canvas-host");
    this.stage.className = "canvas-stage";
    this.edges.classList.add("canvas-edges");
    this.stage.appendChild(this.edges);
    host.appendChild(this.stage);
    host.addEventListener("dblclick", (event) => {
      if (event.target !== host && event.target !== this.stage) return;
      const rect = this.stage.getBoundingClientRect();
      this.addText(event.clientX - rect.left, event.clientY - rect.top);
    });
    host.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && this.connectingFrom) {
        this.connectingFrom = null;
        host.classList.remove("connecting");
        return;
      }
      if ((event.key === "Delete" || event.key === "Backspace") && this.selected) {
        event.preventDefault();
        this.deleteSelected();
      }
    });
  }

  open(source: string) {
    this.document = parseCanvas(source);
    this.selected = null;
    this.connectingFrom = null;
    this.hostElement().classList.remove("connecting");
    this.render();
  }

  clear() {
    this.document = null;
    this.connectingFrom = null;
    this.hostElement().classList.remove("connecting");
    this.stage.querySelectorAll(".canvas-node").forEach((node) => node.remove());
    this.edges.replaceChildren();
  }

  addText(x = 80, y = 80) {
    if (!this.document) return;
    const node: CanvasNode = { id: id("node"), type: "text", x, y, width: 260, height: 120, text: "New text" };
    this.document.nodes.push(node);
    this.selected = node.id;
    this.changed();
  }

  addFile(path: string, x = 100, y = 100) {
    if (!this.document) return;
    this.document.nodes.push({ id: id("node"), type: "file", file: path, x, y, width: 280, height: 80 });
    this.changed();
  }

  deleteSelected() {
    if (!this.document || !this.selected) return;
    const selected = this.selected;
    this.document.nodes = this.document.nodes.filter((node) => node.id !== selected);
    this.document.edges = this.document.edges.filter((edge) => edge.fromNode !== selected && edge.toNode !== selected);
    this.selected = null;
    this.changed();
  }

  beginConnect(): boolean {
    if (!this.selected) return false;
    this.connectingFrom = this.selected;
    this.hostElement().classList.add("connecting");
    return true;
  }

  private hostElement(): HTMLElement {
    return this.stage.parentElement as HTMLElement;
  }

  private changed() {
    if (!this.document) return;
    this.render();
    this.onChange(serializeCanvas(this.document));
  }

  private render() {
    if (!this.document) return;
    this.stage.querySelectorAll(".canvas-node").forEach((node) => node.remove());
    let maxX = 1200;
    let maxY = 800;
    const byId = new Map(this.document.nodes.map((node) => [node.id, node]));
    for (const node of this.document.nodes) {
      maxX = Math.max(maxX, node.x + node.width + 120);
      maxY = Math.max(maxY, node.y + node.height + 120);
    }
    this.stage.style.width = `${maxX}px`;
    this.stage.style.height = `${maxY}px`;
    this.renderEdges(byId, maxX, maxY);
    for (const node of this.document.nodes) this.stage.appendChild(this.renderNode(node));
  }

  private renderEdges(nodes: Map<string, CanvasNode>, width: number, height: number) {
    this.edges.replaceChildren();
    this.edges.setAttribute("viewBox", `0 0 ${width} ${height}`);
    this.edges.setAttribute("width", String(width));
    this.edges.setAttribute("height", String(height));
    const definitions = document.createElementNS("http://www.w3.org/2000/svg", "defs");
    const marker = document.createElementNS("http://www.w3.org/2000/svg", "marker");
    marker.setAttribute("id", "canvas-arrow");
    marker.setAttribute("viewBox", "0 0 10 10");
    marker.setAttribute("refX", "9");
    marker.setAttribute("refY", "5");
    marker.setAttribute("markerWidth", "6");
    marker.setAttribute("markerHeight", "6");
    marker.setAttribute("orient", "auto-start-reverse");
    const arrow = document.createElementNS("http://www.w3.org/2000/svg", "path");
    arrow.setAttribute("d", "M 0 0 L 10 5 L 0 10 z");
    marker.appendChild(arrow);
    definitions.appendChild(marker);
    this.edges.appendChild(definitions);
    for (const edge of this.document?.edges ?? []) {
      const from = nodes.get(edge.fromNode);
      const to = nodes.get(edge.toNode);
      if (!from || !to) continue;
      const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      line.setAttribute("x1", String(from.x + from.width / 2));
      line.setAttribute("y1", String(from.y + from.height / 2));
      line.setAttribute("x2", String(to.x + to.width / 2));
      line.setAttribute("y2", String(to.y + to.height / 2));
      line.setAttribute("marker-end", "url(#canvas-arrow)");
      if (edge.color) line.style.stroke = edge.color;
      this.edges.appendChild(line);
      if (edge.label) {
        const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
        label.setAttribute("x", String((from.x + from.width / 2 + to.x + to.width / 2) / 2));
        label.setAttribute("y", String((from.y + from.height / 2 + to.y + to.height / 2) / 2 - 5));
        label.textContent = edge.label;
        this.edges.appendChild(label);
      }
    }
  }

  private renderNode(node: CanvasNode): HTMLElement {
    const element = document.createElement("article");
    element.className = `canvas-node canvas-node-${node.type}${this.selected === node.id ? " selected" : ""}`;
    element.tabIndex = 0;
    element.style.left = `${node.x}px`;
    element.style.top = `${node.y}px`;
    element.style.width = `${Math.max(80, node.width)}px`;
    element.style.height = `${Math.max(48, node.height)}px`;
    if (node.color) element.dataset.color = node.color;
    const header = document.createElement("header");
    header.textContent = node.type === "group" ? node.label || "Group" : node.type;
    const content = document.createElement("div");
    content.className = "canvas-node-content";
    content.textContent = node.type === "file" ? node.file || "Missing file" :
      node.type === "link" ? node.url || "Missing URL" : node.text || "";
    if (node.type === "text") {
      content.addEventListener("dblclick", (event) => {
        event.stopPropagation();
        content.contentEditable = "true";
        content.focus();
      });
      content.addEventListener("blur", () => {
        content.contentEditable = "false";
        if (this.document && node.text !== content.textContent) {
          node.text = content.textContent ?? "";
          this.onChange(serializeCanvas(this.document));
        }
      });
    } else if (node.type === "file" && node.file) {
      content.classList.add("canvas-node-link");
      content.addEventListener("dblclick", () => this.onOpenFile(node.file!));
    } else if (node.type === "link" && node.url) {
      content.classList.add("canvas-node-link");
      content.addEventListener("dblclick", () => this.onOpenUrl(node.url!));
    }
    element.append(header, content);
    element.addEventListener("pointerdown", (event) => this.startDrag(event, node, element));
    element.addEventListener("click", () => {
      if (this.document && this.connectingFrom && this.connectingFrom !== node.id) {
        this.document.edges.push({
          id: id("edge"),
          fromNode: this.connectingFrom,
          toNode: node.id,
        });
        this.connectingFrom = null;
        this.hostElement().classList.remove("connecting");
        this.selected = node.id;
        this.changed();
        return;
      }
      this.selected = node.id;
      this.stage.querySelectorAll(".canvas-node.selected").forEach((item) => item.classList.remove("selected"));
      element.classList.add("selected");
    });
    return element;
  }

  private startDrag(event: PointerEvent, node: CanvasNode, element: HTMLElement) {
    if ((event.target as HTMLElement).isContentEditable) return;
    const startX = event.clientX;
    const startY = event.clientY;
    const x = node.x;
    const y = node.y;
    element.setPointerCapture(event.pointerId);
    const move = (next: PointerEvent) => {
      node.x = Math.round(x + next.clientX - startX);
      node.y = Math.round(y + next.clientY - startY);
      element.style.left = `${node.x}px`;
      element.style.top = `${node.y}px`;
      if (this.document) this.renderEdges(new Map(this.document.nodes.map((item) => [item.id, item])), this.stage.clientWidth, this.stage.clientHeight);
    };
    const end = () => {
      element.removeEventListener("pointermove", move);
      element.removeEventListener("pointerup", end);
      if (this.document) this.onChange(serializeCanvas(this.document));
    };
    element.addEventListener("pointermove", move);
    element.addEventListener("pointerup", end);
  }
}
