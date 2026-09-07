export type KanbanDragOrigin = {
  fromCol: number;
  fromIdx: number;
};

export type ImmediateKanbanDragOptions = {
  thresholdPx?: number;
  onPress?: () => void;
  onAcquire?: () => void;
  onRelease?: (acquired: boolean) => void;
  onDrop: (origin: KanbanDragOrigin, toCol: number) => void;
};

/**
 * WebKit's native HTML drag gesture is slow to acquire when a card contains a
 * button, and its dragover delivery is heavily throttled. Drive an internal
 * board move directly from pointer events instead. The hot path performs one
 * hit test and only mutates classes when the target lane actually changes.
 */
export function bindImmediateKanbanDrag(
  card: HTMLElement,
  origin: KanbanDragOrigin,
  options: ImmediateKanbanDragOptions,
): () => void {
  const view = card.ownerDocument.defaultView;
  if (!view) return () => {};
  const threshold = Math.max(1, options.thresholdPx ?? 3);
  let startX = 0;
  let startY = 0;
  let pointerId: number | null = null;
  let acquired = false;
  let suppressClick = false;
  let targetLane: HTMLElement | null = null;
  let targetSurface: HTMLElement | null = null;
  let ghost: HTMLElement | null = null;
  let grabX = 0;
  let grabY = 0;

  // Disable the competing native gesture. Pointer capture works equally well
  // when the initial press lands on the card's nested link button or cover.
  card.draggable = false;

  const clearTarget = () => {
    targetSurface?.classList.remove("drag-over");
    targetLane?.classList.remove("drag-over");
    targetSurface = null;
    targetLane = null;
  };

  const laneAt = (x: number, y: number): HTMLElement | null => {
    const hit = card.ownerDocument.elementFromPoint(x, y);
    return hit instanceof view.HTMLElement
      ? hit.closest<HTMLElement>(".kanban-col[data-col]")
      : null;
  };

  const activateLane = (lane: HTMLElement | null) => {
    if (lane === targetLane) return;
    clearTarget();
    if (!lane) return;
    targetLane = lane;
    targetSurface = lane.classList.contains("kanban-col-collapsed")
      ? lane
      : lane.querySelector<HTMLElement>(".kanban-cards") ?? lane;
    targetSurface.classList.add("drag-over");
  };

  const positionGhost = (x: number, y: number) => {
    if (!ghost) return;
    ghost.style.transform = `translate3d(${x - grabX}px, ${y - grabY}px, 0)`;
  };

  const onMove = (event: PointerEvent) => {
    if (event.pointerId !== pointerId) return;
    if (!acquired) {
      const dx = event.clientX - startX;
      const dy = event.clientY - startY;
      if ((dx * dx) + (dy * dy) < threshold * threshold) return;
      acquired = true;
      suppressClick = true;
      options.onAcquire?.();
      card.classList.add("dragging");
      card.ownerDocument.body.classList.add("kanban-dragging");
      const rect = card.getBoundingClientRect();
      grabX = startX - rect.left;
      grabY = startY - rect.top;
      ghost = card.cloneNode(true) as HTMLElement;
      ghost.classList.remove("dragging");
      ghost.classList.add("kanban-drag-ghost");
      ghost.removeAttribute("id");
      ghost.style.width = `${rect.width}px`;
      ghost.style.height = `${rect.height}px`;
      card.ownerDocument.body.appendChild(ghost);
      try { card.setPointerCapture(event.pointerId); } catch { /* WebKit may already own it. */ }
    }
    event.preventDefault();
    positionGhost(event.clientX, event.clientY);
    activateLane(laneAt(event.clientX, event.clientY));
  };

  const finish = (event: PointerEvent, drop: boolean) => {
    if (event.pointerId !== pointerId) return;
    const lane = targetLane;
    const wasAcquired = acquired;
    if (acquired) event.preventDefault();
    clearTarget();
    card.classList.remove("dragging");
    card.ownerDocument.body.classList.remove("kanban-dragging");
    ghost?.remove();
    ghost = null;
    try { card.releasePointerCapture(event.pointerId); } catch { /* Capture is optional. */ }
    pointerId = null;
    acquired = false;
    if (suppressClick) view.setTimeout(() => { suppressClick = false; }, 0);
    view.removeEventListener("pointermove", onMove);
    view.removeEventListener("pointerup", onUp);
    view.removeEventListener("pointercancel", onCancel);
    options.onRelease?.(wasAcquired);
    const toCol = Number(lane?.dataset.col);
    if (drop && lane && Number.isInteger(toCol) && toCol !== origin.fromCol) {
      options.onDrop(origin, toCol);
    }
  };

  const onUp = (event: PointerEvent) => finish(event, true);
  const onCancel = (event: PointerEvent) => finish(event, false);
  const onDown = (event: PointerEvent) => {
    if (event.button !== 0 || !event.isPrimary || pointerId != null) return;
    pointerId = event.pointerId;
    startX = event.clientX;
    startY = event.clientY;
    // Kill a pending hover before it can compete with drag acquisition.
    options.onPress?.();
    view.addEventListener("pointermove", onMove, { passive: false });
    view.addEventListener("pointerup", onUp);
    view.addEventListener("pointercancel", onCancel);
  };
  const onClick = (event: MouseEvent) => {
    if (!suppressClick) return;
    suppressClick = false;
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  card.addEventListener("pointerdown", onDown);
  card.addEventListener("click", onClick, true);
  return () => {
    card.removeEventListener("pointerdown", onDown);
    card.removeEventListener("click", onClick, true);
    if (pointerId != null) {
      clearTarget();
      ghost?.remove();
      ghost = null;
      view.removeEventListener("pointermove", onMove);
      view.removeEventListener("pointerup", onUp);
      view.removeEventListener("pointercancel", onCancel);
    }
  };
}
