import type { GraphData, GraphNode } from "./types";

type Point = { x: number; y: number; vx: number; vy: number };

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
  search.placeholder = "Filter graph nodes…";
  search.autocomplete = "off";
  const summary = document.createElement("span");
  controls.append(search, summary);
  const viewport = document.createElement("div");
  viewport.className = "graph-viewport";
  const svg = svgElement("svg");
  svg.setAttribute("viewBox", "0 0 1100 680");
  svg.classList.add("graph-svg");
  viewport.appendChild(svg);
  host.append(controls, viewport);

  const draw = () => {
    const query = search.value.trim().toLowerCase();
    const matching = query
      ? new Set(data.nodes.filter((node) => `${node.title} ${node.path}`.toLowerCase().includes(query)).map((node) => node.path))
      : null;
    const included = matching
      ? new Set(data.edges.flatMap((edge) => matching.has(edge.source) || matching.has(edge.target) ? [edge.source, edge.target] : []))
      : new Set(data.nodes.map((node) => node.path));
    for (const path of matching ?? []) included.add(path);
    const degree = new Map<string, number>();
    for (const edge of data.edges) {
      degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
      degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
    }
    const nodes = data.nodes
      .filter((node) => included.has(node.path))
      .sort((left, right) =>
        Number(right.path === initialFocus) - Number(left.path === initialFocus) ||
        (degree.get(right.path) ?? 0) - (degree.get(left.path) ?? 0) ||
        left.path.localeCompare(right.path)
      )
      .slice(0, 350);
    const paths = new Set(nodes.map((node) => node.path));
    const edges = data.edges.filter((edge) => paths.has(edge.source) && paths.has(edge.target)).slice(0, 1000);
    const visible: GraphData = { nodes, edges };
    const points = layoutGraph(visible);
    svg.replaceChildren();
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
    svg.appendChild(edgeLayer);
    const nodeLayer = svgElement("g");
    nodeLayer.classList.add("graph-nodes");
    for (const node of nodes) {
      const p = points.get(node.path)!;
      const group = svgElement("g");
      group.setAttribute("transform", `translate(${p.x} ${p.y})`);
      group.classList.toggle("focused", node.path === initialFocus);
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
      group.addEventListener("click", () => onOpen(node.path));
      group.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") onOpen(node.path);
      });
      nodeLayer.appendChild(group);
    }
    svg.appendChild(nodeLayer);
    summary.textContent = `${nodes.length} notes · ${edges.length} links${data.nodes.length > 350 ? " · first 350 shown" : ""}`;
  };
  search.addEventListener("input", draw);
  draw();
}

export function graphTitle(node: GraphNode): string {
  return node.title || node.path.replace(/\.md$/i, "").split("/").pop() || node.path;
}
