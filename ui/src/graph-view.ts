import type { GraphData, GraphNode } from "./types";

type Point = { x: number; y: number; vx: number; vy: number };

export type GraphDirection = "both" | "incoming" | "outgoing";

export type GraphFilterOptions = {
  scope: "global" | "local";
  focus?: string | null;
  depth: number;
  direction: GraphDirection;
  query?: string;
  folder?: string;
  tag?: string;
  expanded?: ReadonlySet<string>;
  nodeLimit?: number;
  edgeLimit?: number;
};

export function graphRelationships(data: GraphData, path: string) {
  return {
    incoming: data.edges.filter((edge) => edge.target === path),
    outgoing: data.edges.filter((edge) => edge.source === path),
  };
}

function neighboringPaths(
  data: GraphData,
  path: string,
  direction: GraphDirection,
): string[] {
  const neighbors: string[] = [];
  for (const edge of data.edges) {
    if (direction !== "incoming" && edge.source === path) neighbors.push(edge.target);
    if (direction !== "outgoing" && edge.target === path) neighbors.push(edge.source);
  }
  return neighbors;
}

export function selectGraphData(data: GraphData, options: GraphFilterOptions): GraphData {
  const nodeByPath = new Map(data.nodes.map((node) => [node.path, node]));
  const query = options.query?.trim().toLowerCase() ?? "";
  const folder = options.folder?.replace(/\/$/, "") ?? "";
  const tag = options.tag?.trim().toLowerCase() ?? "";
  const matchesFilters = (path: string) => {
    const node = nodeByPath.get(path);
    if (!node) return false;
    if (query && !`${node.title} ${node.path} ${node.tags.join(" ")}`.toLowerCase().includes(query)) {
      return false;
    }
    if (folder && path !== folder && !path.startsWith(`${folder}/`)) return false;
    if (tag && !node.tags.some((candidate) => candidate.toLowerCase() === tag)) return false;
    return true;
  };

  const included = new Set<string>();
  if (options.scope === "local" && options.focus && nodeByPath.has(options.focus)) {
    included.add(options.focus);
    let frontier = new Set([options.focus]);
    for (let level = 0; level < Math.max(0, options.depth); level++) {
      const next = new Set<string>();
      for (const path of frontier) {
        for (const neighbor of neighboringPaths(data, path, options.direction)) {
          if (!included.has(neighbor) && matchesFilters(neighbor)) next.add(neighbor);
        }
      }
      for (const path of next) included.add(path);
      frontier = next;
    }
  } else {
    for (const node of data.nodes) if (matchesFilters(node.path)) included.add(node.path);
  }

  for (const path of options.expanded ?? []) {
    if (!nodeByPath.has(path)) continue;
    included.add(path);
    for (const neighbor of neighboringPaths(data, path, "both")) {
      if (matchesFilters(neighbor)) included.add(neighbor);
    }
  }

  const degree = new Map<string, number>();
  for (const edge of data.edges) {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
  }
  const nodes = data.nodes
    .filter((node) => included.has(node.path))
    .sort((left, right) =>
      Number(right.path === options.focus) - Number(left.path === options.focus)
      || (degree.get(right.path) ?? 0) - (degree.get(left.path) ?? 0)
      || left.path.localeCompare(right.path))
    .slice(0, options.nodeLimit ?? 350);
  const paths = new Set(nodes.map((node) => node.path));
  const edges = data.edges
    .filter((edge) => paths.has(edge.source) && paths.has(edge.target))
    .slice(0, options.edgeLimit ?? 1000);
  return { nodes, edges };
}

function seededPosition(key: string, width: number, height: number): Point {
  let hash = 2166136261;
  for (const character of key) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  const angle = ((hash >>> 0) / 0xffffffff) * Math.PI * 2;
  const radius = Math.min(width, height) * (0.18 + ((hash >>> 9) & 255) / 900);
  return {
    x: width / 2 + Math.cos(angle) * radius,
    y: height / 2 + Math.sin(angle) * radius,
    vx: 0,
    vy: 0,
  };
}

export function layoutGraph(data: GraphData, width = 1100, height = 680): Map<string, Point> {
  const points = new Map(data.nodes.map((node) => [node.path, seededPosition(node.path, width, height)]));
  const degree = new Map<string, number>();
  for (const edge of data.edges) {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
  }
  // A bounded deterministic force pass is cheap enough for a vault overview
  // and avoids taking a runtime dependency on a graph package.
  const nodes = data.nodes.slice(0, 350);
  for (let tick = 0; tick < 60; tick++) {
    for (let i = 0; i < nodes.length; i++) {
      const a = points.get(nodes[i].path)!;
      for (let j = i + 1; j < nodes.length; j++) {
        const b = points.get(nodes[j].path)!;
        const dx = b.x - a.x || 0.1;
        const dy = b.y - a.y || 0.1;
        const distance2 = Math.max(64, dx * dx + dy * dy);
        const force = Math.min(1.8, 2100 / distance2);
        a.vx -= dx * force / Math.sqrt(distance2);
        a.vy -= dy * force / Math.sqrt(distance2);
        b.vx += dx * force / Math.sqrt(distance2);
        b.vy += dy * force / Math.sqrt(distance2);
      }
    }
    for (const edge of data.edges) {
      const a = points.get(edge.source);
      const b = points.get(edge.target);
      if (!a || !b) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const distance = Math.max(1, Math.hypot(dx, dy));
      const force = (distance - 105) * 0.004;
      a.vx += dx * force;
      a.vy += dy * force;
      b.vx -= dx * force;
      b.vy -= dy * force;
    }
    for (const node of nodes) {
      const p = points.get(node.path)!;
      p.vx += (width / 2 - p.x) * 0.0008;
      p.vy += (height / 2 - p.y) * 0.0008;
      p.vx *= 0.72;
      p.vy *= 0.72;
      p.x = Math.max(18, Math.min(width - 18, p.x + p.vx));
      p.y = Math.max(18, Math.min(height - 18, p.y + p.vy));
    }
  }
  return points;
}

function svgElement<K extends keyof SVGElementTagNameMap>(name: K): SVGElementTagNameMap[K] {
  return document.createElementNS("http://www.w3.org/2000/svg", name);
}

export function renderGraph(
  host: HTMLElement,
  data: GraphData,
  onOpen: (path: string) => void,
  initialFocus?: string | null,
) {
  host.replaceChildren();
  const controls = document.createElement("div");
  controls.className = "graph-controls";
  const search = document.createElement("input");
  search.type = "search";
  search.placeholder = "Filter titles, paths, or tags…";
  search.autocomplete = "off";
  const scope = graphSelect(["global", "local"], initialFocus ? "local" : "global", "Graph scope");
  const depth = graphSelect(["2", "3", "4", "5"], "2", "Local graph depth");
  const direction = graphSelect(["both", "incoming", "outgoing"], "both", "Link direction");
  const folders = [...new Set(data.nodes.map((node) => node.path.split("/").slice(0, -1).join("/")))]
    .filter(Boolean).sort((left, right) => left.localeCompare(right));
  const folder = graphSelect(["", ...folders], "", "Folder filter", "All folders");
  const tags = [...new Set(data.nodes.flatMap((node) => node.tags))]
    .sort((left, right) => left.localeCompare(right));
  const tag = graphSelect(["", ...tags], "", "Tag filter", "All tags");
  const fit = document.createElement("button");
  fit.type = "button";
  fit.textContent = "Fit";
  fit.title = "Reset graph pan and zoom";
  const summary = document.createElement("span");
  controls.append(scope, depth, direction, folder, tag, search, fit, summary);
  const content = document.createElement("div");
  content.className = "graph-content";
  const viewport = document.createElement("div");
  viewport.className = "graph-viewport";
  const svg = svgElement("svg");
  svg.setAttribute("viewBox", "0 0 1100 680");
  svg.classList.add("graph-svg");
  viewport.appendChild(svg);
  const inspector = document.createElement("aside");
  inspector.className = "graph-inspector";
  content.append(viewport, inspector);
  host.append(controls, content);

  let focusPath = initialFocus ?? null;
  let selectedPath = initialFocus ?? null;
  const expanded = new Set<string>();
  let panX = 0;
  let panY = 0;
  let zoom = 1;
  let scene: SVGGElement | null = null;

  const applyTransform = () => {
    scene?.setAttribute("transform", `translate(${panX} ${panY}) scale(${zoom})`);
  };

  const drawInspector = () => {
    inspector.replaceChildren();
    if (!selectedPath) {
      inspector.innerHTML = '<p class="feature-help">Select a note to inspect its links.</p>';
      return;
    }
    const node = data.nodes.find((candidate) => candidate.path === selectedPath);
    if (!node) return;
    const heading = document.createElement("h3");
    heading.textContent = graphTitle(node);
    const path = document.createElement("code");
    path.textContent = node.path;
    const tagList = document.createElement("div");
    tagList.className = "graph-inspector-tags";
    for (const value of node.tags) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = `#${value}`;
      button.addEventListener("click", () => {
        tag.value = value;
        draw();
      });
      tagList.appendChild(button);
    }
    const actions = document.createElement("div");
    actions.className = "graph-inspector-actions";
    const open = document.createElement("button");
    open.type = "button";
    open.textContent = "Open note";
    open.addEventListener("click", () => onOpen(node.path));
    const center = document.createElement("button");
    center.type = "button";
    center.textContent = "Local graph here";
    center.addEventListener("click", () => {
      focusPath = node.path;
      scope.value = "local";
      draw();
    });
    const expand = document.createElement("button");
    expand.type = "button";
    expand.textContent = expanded.has(node.path) ? "Collapse neighbors" : "Expand neighbors";
    expand.addEventListener("click", () => {
      if (expanded.has(node.path)) expanded.delete(node.path);
      else expanded.add(node.path);
      draw();
    });
    actions.append(open, center, expand);
    inspector.append(heading, path, tagList, actions);
    const relationships = graphRelationships(data, node.path);
    appendRelationshipList(inspector, "Incoming", relationships.incoming.map((edge) => edge.source), data, (next) => {
      selectedPath = next;
      drawInspector();
    }, onOpen);
    appendRelationshipList(inspector, "Outgoing", relationships.outgoing.map((edge) => edge.target), data, (next) => {
      selectedPath = next;
      drawInspector();
    }, onOpen);
  };

  const draw = () => {
    const visible = selectGraphData(data, {
      scope: scope.value as "global" | "local",
      focus: focusPath,
      depth: Number(depth.value),
      direction: direction.value as GraphDirection,
      query: search.value,
      folder: folder.value,
      tag: tag.value,
      expanded,
    });
    const { nodes, edges } = visible;
    const points = layoutGraph(visible);
    svg.replaceChildren();
    scene = svgElement("g");
    scene.classList.add("graph-scene");
    const edgeLayer = svgElement("g");
    edgeLayer.classList.add("graph-edges");
    for (const edge of edges) {
      const a = points.get(edge.source)!;
      const b = points.get(edge.target)!;
      const line = svgElement("line");
      line.setAttribute("x1", String(a.x));
      line.setAttribute("y1", String(a.y));
      line.setAttribute("x2", String(b.x));
      line.setAttribute("y2", String(b.y));
      if (edge.embeds) line.classList.add("embed");
      edgeLayer.appendChild(line);
    }
    scene.appendChild(edgeLayer);
    const nodeLayer = svgElement("g");
    nodeLayer.classList.add("graph-nodes");
    for (const node of nodes) {
      const p = points.get(node.path)!;
      const group = svgElement("g");
      group.setAttribute("transform", `translate(${p.x} ${p.y})`);
      group.classList.toggle("focused", node.path === focusPath);
      group.classList.toggle("selected", node.path === selectedPath);
      group.setAttribute("tabindex", "0");
      group.setAttribute("role", "button");
      const circle = svgElement("circle");
      const d = visible.edges.filter((edge) => edge.source === node.path || edge.target === node.path).length;
      circle.setAttribute("r", String(Math.min(15, 5 + Math.sqrt(d) * 2.2)));
      const title = svgElement("title");
      title.textContent = node.path;
      const label = svgElement("text");
      label.setAttribute("y", "-10");
      label.textContent = node.title;
      group.append(circle, title, label);
      group.addEventListener("click", (event) => {
        event.stopPropagation();
        selectedPath = node.path;
        draw();
      });
      group.addEventListener("dblclick", () => onOpen(node.path));
      group.addEventListener("keydown", (event) => {
        if (event.key === "Enter") onOpen(node.path);
        if (event.key === " ") {
          event.preventDefault();
          selectedPath = node.path;
          draw();
        }
      });
      nodeLayer.appendChild(group);
    }
    scene.appendChild(nodeLayer);
    svg.appendChild(scene);
    applyTransform();
    summary.textContent = `${nodes.length} notes · ${edges.length} links${nodes.length === 350 ? " · limit reached" : ""}`;
    depth.disabled = scope.value !== "local";
    direction.disabled = scope.value !== "local";
    drawInspector();
  };

  let drag: { x: number; y: number; panX: number; panY: number } | null = null;
  svg.addEventListener("pointerdown", (event) => {
    if ((event.target as Element).closest(".graph-nodes")) return;
    drag = { x: event.clientX, y: event.clientY, panX, panY };
    svg.setPointerCapture(event.pointerId);
  });
  svg.addEventListener("pointermove", (event) => {
    if (!drag) return;
    const rect = svg.getBoundingClientRect();
    panX = drag.panX + (event.clientX - drag.x) * 1100 / rect.width;
    panY = drag.panY + (event.clientY - drag.y) * 680 / rect.height;
    applyTransform();
  });
  const stopDrag = () => { drag = null; };
  svg.addEventListener("pointerup", stopDrag);
  svg.addEventListener("pointercancel", stopDrag);
  svg.addEventListener("wheel", (event) => {
    event.preventDefault();
    const rect = svg.getBoundingClientRect();
    const x = (event.clientX - rect.left) * 1100 / rect.width;
    const y = (event.clientY - rect.top) * 680 / rect.height;
    const next = Math.max(0.35, Math.min(4, zoom * (event.deltaY < 0 ? 1.12 : 0.89)));
    panX = x - (x - panX) * next / zoom;
    panY = y - (y - panY) * next / zoom;
    zoom = next;
    applyTransform();
  }, { passive: false });
  fit.addEventListener("click", () => {
    panX = 0;
    panY = 0;
    zoom = 1;
    applyTransform();
  });
  search.addEventListener("input", draw);
  for (const control of [scope, depth, direction, folder, tag]) control.addEventListener("change", draw);
  draw();
}

function graphSelect(
  values: string[],
  selected: string,
  label: string,
  emptyLabel?: string,
): HTMLSelectElement {
  const select = document.createElement("select");
  select.className = "graph-select";
  select.title = label;
  select.setAttribute("aria-label", label);
  for (const value of values) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value || emptyLabel || "All";
    option.selected = value === selected;
    select.appendChild(option);
  }
  return select;
}

function appendRelationshipList(
  inspector: HTMLElement,
  title: string,
  paths: string[],
  data: GraphData,
  onSelect: (path: string) => void,
  onOpen: (path: string) => void,
) {
  const heading = document.createElement("h4");
  heading.textContent = `${title} (${paths.length})`;
  const list = document.createElement("div");
  list.className = "graph-relationship-list";
  for (const path of paths.sort((left, right) => left.localeCompare(right))) {
    const node = data.nodes.find((candidate) => candidate.path === path);
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = node ? graphTitle(node) : path;
    button.title = `${path} · double-click to open`;
    button.addEventListener("click", () => onSelect(path));
    button.addEventListener("dblclick", () => onOpen(path));
    list.appendChild(button);
  }
  if (!paths.length) list.textContent = "None";
  inspector.append(heading, list);
}

export function graphTitle(node: GraphNode): string {
  return node.title || node.path.replace(/\.md$/i, "").split("/").pop() || node.path;
}
