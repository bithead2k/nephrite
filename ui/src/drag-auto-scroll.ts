export function edgeScrollDelta(
  position: number,
  start: number,
  end: number,
  threshold = 54,
  maxSpeed = 18,
): number {
  const edge = Math.max(1, Math.min(threshold, (end - start) / 2));
  if (position < start + edge) {
    const strength = Math.min(1, Math.max(0, (start + edge - position) / edge));
    return -Math.max(1, Math.round(maxSpeed * strength * strength));
  }
  if (position > end - edge) {
    const strength = Math.min(1, Math.max(0, (position - (end - edge)) / edge));
    return Math.max(1, Math.round(maxSpeed * strength * strength));
  }
  return 0;
}

export type DragAutoScroller = {
  update: (x: number, y: number) => void;
  stop: () => void;
};

/** Smoothly scroll the supplied drag surfaces while the pointer hugs an edge. */
export function createDragAutoScroller(
  view: Window,
  containers: () => readonly HTMLElement[],
): DragAutoScroller {
  let x = 0;
  let y = 0;
  let frame = 0;
  let active = false;
  const requestFrame = view.requestAnimationFrame?.bind(view)
    ?? ((callback: FrameRequestCallback) => view.setTimeout(() => callback(performance.now()), 16));
  const cancelFrame = view.cancelAnimationFrame?.bind(view) ?? view.clearTimeout.bind(view);

  const tick = () => {
    frame = 0;
    if (!active) return;
    let moved = false;
    for (const container of containers()) {
      const rect = container.getBoundingClientRect();
      const dx = container.scrollWidth > container.clientWidth
        ? edgeScrollDelta(x, rect.left, rect.right)
        : 0;
      const dy = container.scrollHeight > container.clientHeight
        ? edgeScrollDelta(y, rect.top, rect.bottom)
        : 0;
      if (!dx && !dy) continue;
      const beforeLeft = container.scrollLeft;
      const beforeTop = container.scrollTop;
      container.scrollBy(dx, dy);
      moved ||= container.scrollLeft !== beforeLeft || container.scrollTop !== beforeTop;
    }
    if (active && (moved || containers().length)) frame = requestFrame(tick);
  };

  return {
    update(nextX, nextY) {
      x = nextX;
      y = nextY;
      active = true;
      if (!frame) frame = requestFrame(tick);
    },
    stop() {
      active = false;
      if (frame) cancelFrame(frame);
      frame = 0;
    },
  };
}
