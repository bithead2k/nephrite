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

export function resizedCanvasNodeSize(
  width: number,
  height: number,
  deltaX: number,
  deltaY: number,
  zoom = 1,
) {
  return {
    width: Math.max(80, Math.round(width + deltaX / zoom)),
    height: Math.max(48, Math.round(height + deltaY / zoom)),
  };
}

export function duplicateCanvasSelection(
  document: CanvasDocument,
  selected: ReadonlySet<string>,
  offset = 32,
): { nodes: CanvasNode[]; edges: CanvasEdge[]; selected: Set<string> } {
  const idMap = new Map<string, string>();
  const nodes = document.nodes.filter((node) => selected.has(node.id)).map((node) => {
    const nextId = id("node");
    idMap.set(node.id, nextId);
    return { ...node, id: nextId, x: node.x + offset, y: node.y + offset };
  });
  const edges = document.edges
    .filter((edge) => idMap.has(edge.fromNode) && idMap.has(edge.toNode))
    .map((edge) => ({
      ...edge,
      id: id("edge"),
      fromNode: idMap.get(edge.fromNode)!,
      toNode: idMap.get(edge.toNode)!,
    }));
  return { nodes, edges, selected: new Set(nodes.map((node) => node.id)) };
}

export function canvasNodeAnchor(
  node: CanvasNode,
  side: string | undefined,
  toward: { x: number; y: number },
): { x: number; y: number } {
  const center = { x: node.x + node.width / 2, y: node.y + node.height / 2 };
  const resolved = side && side !== "auto" ? side :
    Math.abs(toward.x - center.x) >= Math.abs(toward.y - center.y)
      ? toward.x >= center.x ? "right" : "left"
      : toward.y >= center.y ? "bottom" : "top";
  if (resolved === "left") return { x: node.x, y: center.y };
  if (resolved === "right") return { x: node.x + node.width, y: center.y };
  if (resolved === "top") return { x: center.x, y: node.y };
  if (resolved === "bottom") return { x: center.x, y: node.y + node.height };
  return center;
}

export class CanvasView {
  private document: CanvasDocument | null = null;
  private selected = new Set<string>();
  private selectedEdge: string | null = null;
  private connectingFrom: string | null = null;
  private clipboard: { nodes: CanvasNode[]; edges: CanvasEdge[] } | null = null;
  private zoom = 1;
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
      this.addText((event.clientX - rect.left) / this.zoom, (event.clientY - rect.top) / this.zoom);
    });
    host.addEventListener("pointerdown", (event) => this.startMarquee(event));
    host.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && this.connectingFrom) {
        this.connectingFrom = null;
        host.classList.remove("connecting");
        return;
      }
      if ((event.key === "Delete" || event.key === "Backspace") && (this.selected.size || this.selectedEdge)) {
        event.preventDefault();
        this.deleteSelected();
      }
      if (this.selected.size && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
        event.preventDefault();
        const step = event.shiftKey ? 20 : 2;
        for (const node of this.document?.nodes ?? []) {
          if (!this.selected.has(node.id)) continue;
          if (event.key === "ArrowLeft") node.x -= step;
          if (event.key === "ArrowRight") node.x += step;
          if (event.key === "ArrowUp") node.y -= step;
          if (event.key === "ArrowDown") node.y += step;
        }
        this.changed();
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a" && this.document) {
        event.preventDefault();
        this.selected = new Set(this.document.nodes.map((node) => node.id));
        this.selectedEdge = null;
        this.render();
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "c" && this.selected.size) {
        event.preventDefault();
        this.copySelection();
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v") {
        event.preventDefault();
        this.pasteCopied();
      }
    });
    host.addEventListener("wheel", (event) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      this.changeZoom(event.deltaY < 0 ? 0.1 : -0.1);
    }, { passive: false });
  }

  open(source: string) {
    this.document = parseCanvas(source);
    this.selected.clear();
    this.selectedEdge = null;
    this.connectingFrom = null;
    this.hostElement().classList.remove("connecting");
    this.render();
  }

  clear() {
    this.document = null;
    this.selected.clear();
    this.selectedEdge = null;
    this.connectingFrom = null;
    this.hostElement().classList.remove("connecting");
    this.stage.querySelectorAll(".canvas-node").forEach((node) => node.remove());
    this.edges.replaceChildren();
  }

  addText(x = 80, y = 80) {
    if (!this.document) return;
    const node: CanvasNode = { id: id("node"), type: "text", x, y, width: 260, height: 120, text: "New text" };
    this.document.nodes.push(node);
    this.selectOnly(node.id);
    this.changed();
  }

  addFile(path: string, x = 100, y = 100) {
    if (!this.document) return;
    const node: CanvasNode = { id: id("node"), type: "file", file: path, x, y, width: 280, height: 80 };
    this.document.nodes.push(node);
    this.selectOnly(node.id);
    this.changed();
  }

  addLink(url: string, label = url, x = 120, y = 120) {
    if (!this.document) return;
    const node: CanvasNode = { id: id("node"), type: "link", url, label, x, y, width: 300, height: 90 };
    this.document.nodes.push(node);
    this.selectOnly(node.id);
    this.changed();
  }

  addGroup(label: string, x = 60, y = 60) {
    if (!this.document) return;
    const node: CanvasNode = { id: id("node"), type: "group", label, x, y, width: 520, height: 320 };
    this.document.nodes.unshift(node);
    this.selectOnly(node.id);
    this.changed();
  }

  setSelectedColor(color: string) {
    if (!this.document || !/^#[0-9a-f]{6}$/i.test(color)) return;
    for (const node of this.document.nodes) {
      if (this.selected.has(node.id)) node.color = color;
    }
    const edge = this.document.edges.find((candidate) => candidate.id === this.selectedEdge);
    if (edge) edge.color = color;
    this.changed();
  }

  changeZoom(delta: number) {
    this.zoom = Math.max(0.4, Math.min(2.5, Math.round((this.zoom + delta) * 10) / 10));
    this.stage.style.zoom = String(this.zoom);
  }

  resetZoom() {
    this.zoom = 1;
    this.stage.style.zoom = "1";
  }

  deleteSelected() {
    if (!this.document || (!this.selected.size && !this.selectedEdge)) return;
    const selected = this.selected;
    this.document.nodes = this.document.nodes.filter((node) => !selected.has(node.id));
    this.document.edges = this.document.edges.filter((edge) =>
      edge.id !== this.selectedEdge && !selected.has(edge.fromNode) && !selected.has(edge.toNode));
    this.selected.clear();
    this.selectedEdge = null;
    this.changed();
  }

  beginConnect(): boolean {
    const selected = this.selected.values().next().value as string | undefined;
    if (!selected) return false;
    this.connectingFrom = selected;
    this.hostElement().classList.add("connecting");
    return true;
  }

  editSelectedEdge(): boolean {
    const edge = this.document?.edges.find((candidate) => candidate.id === this.selectedEdge);
    if (!edge) return false;
    const label = window.prompt("Edge label", edge.label || "");
    if (label == null) return true;
    const valid = new Set(["auto", "left", "right", "top", "bottom"]);
    const fromSide = window.prompt("From side: auto, left, right, top, bottom", edge.fromSide || "auto");
    if (fromSide == null) return true;
    const toSide = window.prompt("To side: auto, left, right, top, bottom", edge.toSide || "auto");
    if (toSide == null) return true;
    if (!valid.has(fromSide) || !valid.has(toSide)) {
      window.alert("Edge sides must be auto, left, right, top, or bottom");
      return true;
    }
    edge.label = label || undefined;
    edge.fromSide = fromSide === "auto" ? undefined : fromSide;
    edge.toSide = toSide === "auto" ? undefined : toSide;
    this.changed();
    return true;
  }

  duplicateSelected() {
    if (!this.document || !this.selected.size) return;
    const duplicated = duplicateCanvasSelection(this.document, this.selected);
    this.document.nodes.push(...duplicated.nodes);
    this.document.edges.push(...duplicated.edges);
    this.selected = duplicated.selected;
    this.selectedEdge = null;
    this.changed();
  }

  copySelection() {
    if (!this.document) return;
    this.clipboard = {
      nodes: this.document.nodes.filter((node) => this.selected.has(node.id)).map((node) => ({ ...node })),
      edges: this.document.edges.filter((edge) =>
        this.selected.has(edge.fromNode) && this.selected.has(edge.toNode)).map((edge) => ({ ...edge })),
    };
  }

  pasteCopied() {
    if (!this.document || !this.clipboard?.nodes.length) return;
    const temporary: CanvasDocument = { nodes: this.clipboard.nodes, edges: this.clipboard.edges };
    const duplicated = duplicateCanvasSelection(
      temporary,
      new Set(temporary.nodes.map((node) => node.id)),
    );
    this.document.nodes.push(...duplicated.nodes);
    this.document.edges.push(...duplicated.edges);
    this.selected = duplicated.selected;
    this.selectedEdge = null;
    this.changed();
  }

  private selectOnly(nodeId: string) {
    this.selected = new Set([nodeId]);
    this.selectedEdge = null;
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
      const fromCenter = { x: from.x + from.width / 2, y: from.y + from.height / 2 };
      const toCenter = { x: to.x + to.width / 2, y: to.y + to.height / 2 };
      const start = canvasNodeAnchor(from, edge.fromSide, toCenter);
      const end = canvasNodeAnchor(to, edge.toSide, fromCenter);
      const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      line.setAttribute("x1", String(start.x));
      line.setAttribute("y1", String(start.y));
      line.setAttribute("x2", String(end.x));
      line.setAttribute("y2", String(end.y));
      line.setAttribute("marker-end", "url(#canvas-arrow)");
      line.classList.add("canvas-edge-line");
      if (this.selectedEdge === edge.id) line.classList.add("selected");
      line.addEventListener("click", (event) => {
        event.stopPropagation();
        this.selected.clear();
        this.selectedEdge = edge.id;
        this.render();
      });
      line.addEventListener("dblclick", (event) => {
        event.stopPropagation();
        this.selectedEdge = edge.id;
        this.editSelectedEdge();
      });
      if (edge.color) line.style.stroke = edge.color;
      this.edges.appendChild(line);
      if (edge.label) {
        const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
        label.setAttribute("x", String((start.x + end.x) / 2));
        label.setAttribute("y", String((start.y + end.y) / 2 - 5));
        label.textContent = edge.label;
        label.classList.add("canvas-edge-label");
        label.addEventListener("click", (event) => {
          event.stopPropagation();
          this.selected.clear();
          this.selectedEdge = edge.id;
          this.render();
        });
        this.edges.appendChild(label);
      }
    }
  }

  private renderNode(node: CanvasNode): HTMLElement {
    const element = document.createElement("article");
    element.className = `canvas-node canvas-node-${node.type}${this.selected.has(node.id) ? " selected" : ""}`;
    element.tabIndex = 0;
    element.dataset.canvasNode = node.id;
    element.style.left = `${node.x}px`;
    element.style.top = `${node.y}px`;
    element.style.width = `${Math.max(80, node.width)}px`;
    element.style.height = `${Math.max(48, node.height)}px`;
    if (node.color) element.dataset.color = node.color;
    if (node.color?.startsWith("#")) element.style.borderColor = node.color;
    const header = document.createElement("header");
    header.textContent = node.type === "group" ? node.label || "Group" : node.type;
    const content = document.createElement("div");
    content.className = "canvas-node-content";
    content.textContent = node.type === "file" ? node.file || "Missing file" :
      node.type === "link" ? node.label || node.url || "Missing URL" : node.text || "";
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
    const resize = document.createElement("button");
    resize.type = "button";
    resize.className = "canvas-node-resize";
    resize.title = "Resize card";
    resize.setAttribute("aria-label", "Resize card");
    resize.addEventListener("pointerdown", (event) => this.startResize(event, node, element));
    element.append(header, content, resize);
    element.addEventListener("pointerdown", (event) => {
      event.stopPropagation();
      if (event.shiftKey || event.ctrlKey || event.metaKey) {
        if (this.selected.has(node.id)) this.selected.delete(node.id);
        else this.selected.add(node.id);
        this.selectedEdge = null;
        this.render();
        return;
      }
      if (!this.selected.has(node.id)) this.selectOnly(node.id);
      this.startDrag(event, node, element);
    });
    element.addEventListener("click", (event) => {
      if (this.document && this.connectingFrom && this.connectingFrom !== node.id) {
        this.document.edges.push({
          id: id("edge"),
          fromNode: this.connectingFrom,
          toNode: node.id,
        });
        this.connectingFrom = null;
        this.hostElement().classList.remove("connecting");
        this.selectOnly(node.id);
        this.changed();
        return;
      }
      if (!(event.shiftKey || event.ctrlKey || event.metaKey)) this.selectOnly(node.id);
      this.render();
    });
    return element;
  }

  private startDrag(event: PointerEvent, node: CanvasNode, element: HTMLElement) {
    if ((event.target as HTMLElement).isContentEditable || (event.target as HTMLElement).closest(".canvas-node-resize")) return;
    const startX = event.clientX;
    const startY = event.clientY;
    const moving = new Set(this.selected);
    if (node.type === "group") {
      for (const candidate of this.document?.nodes ?? []) {
        if (candidate.id === node.id || candidate.type === "group") continue;
        if (candidate.x >= node.x && candidate.y >= node.y &&
            candidate.x + candidate.width <= node.x + node.width &&
            candidate.y + candidate.height <= node.y + node.height) {
          moving.add(candidate.id);
        }
      }
    }
    const origins = new Map((this.document?.nodes ?? [])
      .filter((candidate) => moving.has(candidate.id))
      .map((candidate) => [candidate.id, { x: candidate.x, y: candidate.y }]));
    element.setPointerCapture(event.pointerId);
    const move = (next: PointerEvent) => {
      const deltaX = (next.clientX - startX) / this.zoom;
      const deltaY = (next.clientY - startY) / this.zoom;
      for (const candidate of this.document?.nodes ?? []) {
        const origin = origins.get(candidate.id);
        if (!origin) continue;
        candidate.x = Math.round(origin.x + deltaX);
        candidate.y = Math.round(origin.y + deltaY);
        const candidateElement = Array.from(this.stage.querySelectorAll<HTMLElement>("[data-canvas-node]"))
          .find((item) => item.dataset.canvasNode === candidate.id);
        if (candidateElement) {
          candidateElement.style.left = `${candidate.x}px`;
          candidateElement.style.top = `${candidate.y}px`;
        }
      }
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

  private startMarquee(event: PointerEvent) {
    if (event.button !== 0 || (event.target !== this.hostElement() && event.target !== this.stage)) return;
    const rect = this.stage.getBoundingClientRect();
    const start = {
      x: (event.clientX - rect.left) / this.zoom,
      y: (event.clientY - rect.top) / this.zoom,
    };
    const initial = (event.shiftKey || event.ctrlKey || event.metaKey)
      ? new Set(this.selected)
      : new Set<string>();
    const marquee = document.createElement("div");
    marquee.className = "canvas-marquee";
    marquee.style.left = `${start.x}px`;
    marquee.style.top = `${start.y}px`;
    this.stage.appendChild(marquee);
    this.selectedEdge = null;
    const host = this.hostElement();
    host.setPointerCapture(event.pointerId);
    const move = (next: PointerEvent) => {
      const point = {
        x: (next.clientX - rect.left) / this.zoom,
        y: (next.clientY - rect.top) / this.zoom,
      };
      const left = Math.min(start.x, point.x);
      const top = Math.min(start.y, point.y);
      const right = Math.max(start.x, point.x);
      const bottom = Math.max(start.y, point.y);
      marquee.style.left = `${left}px`;
      marquee.style.top = `${top}px`;
      marquee.style.width = `${right - left}px`;
      marquee.style.height = `${bottom - top}px`;
      this.selected = new Set(initial);
      for (const node of this.document?.nodes ?? []) {
        if (node.x < right && node.x + node.width > left && node.y < bottom && node.y + node.height > top) {
          this.selected.add(node.id);
        }
      }
      this.stage.querySelectorAll<HTMLElement>(".canvas-node").forEach((element) => {
        element.classList.toggle("selected", this.selected.has(element.dataset.canvasNode || ""));
      });
    };
    const end = () => {
      host.removeEventListener("pointermove", move);
      host.removeEventListener("pointerup", end);
      host.removeEventListener("pointercancel", end);
      marquee.remove();
      this.render();
    };
    host.addEventListener("pointermove", move);
    host.addEventListener("pointerup", end);
    host.addEventListener("pointercancel", end);
  }

  private startResize(event: PointerEvent, node: CanvasNode, element: HTMLElement) {
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startY = event.clientY;
    const width = node.width;
    const height = node.height;
    const handle = event.currentTarget as HTMLElement;
    handle.setPointerCapture(event.pointerId);
    const move = (next: PointerEvent) => {
      const size = resizedCanvasNodeSize(
        width,
        height,
        next.clientX - startX,
        next.clientY - startY,
        this.zoom,
      );
      node.width = size.width;
      node.height = size.height;
      element.style.width = `${node.width}px`;
      element.style.height = `${node.height}px`;
      if (this.document) this.renderEdges(new Map(this.document.nodes.map((item) => [item.id, item])), this.stage.clientWidth, this.stage.clientHeight);
    };
    const end = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      if (this.document) this.onChange(serializeCanvas(this.document));
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
  }
}
