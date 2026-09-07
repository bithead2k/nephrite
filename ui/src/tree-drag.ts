export type ImmediateTreeDragOptions = {
  thresholdPx?: number;
  onDrop: (fromPath: string, targetFolder: string) => void;
};

/** Immediate internal vault-tree drag without WebKit's throttled HTML DnD. */
export function bindImmediateTreeDrag(
  source: HTMLElement,
  fromPath: string,
  options: ImmediateTreeDragOptions,
): () => void {
  const view = source.ownerDocument.defaultView;
  if (!view) return () => {};
  const threshold = Math.max(1, options.thresholdPx ?? 3);
  let pointerId: number | null = null;
  let startX = 0;
  let startY = 0;
  let acquired = false;
  let suppressClick = false;
  let target: HTMLElement | null = null;

  source.draggable = false;

  const clearTarget = () => {
    target?.classList.remove("tree-drop");
    target = null;
  };
  const targetAt = (x: number, y: number): HTMLElement | null => {
    const hit = source.ownerDocument.elementFromPoint(x, y);
    if (!(hit instanceof view.HTMLElement)) return null;
    const folder = hit.closest<HTMLElement>(".tree-folder[data-path]");
    if (folder) return folder;
    const host = source.ownerDocument.getElementById("file-tree");
    return hit === host ? host : null;
  };
  const activateTarget = (next: HTMLElement | null) => {
    if (next === target) return;
    clearTarget();
    target = next;
    target?.classList.add("tree-drop");
  };
  const onMove = (event: PointerEvent) => {
    if (event.pointerId !== pointerId) return;
    if (!acquired) {
      const dx = event.clientX - startX;
      const dy = event.clientY - startY;
      if ((dx * dx) + (dy * dy) < threshold * threshold) return;
      acquired = true;
      suppressClick = true;
      source.classList.add("dragging");
      source.ownerDocument.body.classList.add("tree-dragging");
      try { source.setPointerCapture(event.pointerId); } catch { /* Optional in WebKit. */ }
    }
    event.preventDefault();
    activateTarget(targetAt(event.clientX, event.clientY));
  };
  const finish = (event: PointerEvent, drop: boolean) => {
    if (event.pointerId !== pointerId) return;
    const destination = target;
    if (acquired) event.preventDefault();
    clearTarget();
    source.classList.remove("dragging");
    source.ownerDocument.body.classList.remove("tree-dragging");
    try { source.releasePointerCapture(event.pointerId); } catch { /* Optional in WebKit. */ }
    pointerId = null;
    acquired = false;
    if (suppressClick) view.setTimeout(() => { suppressClick = false; }, 0);
    view.removeEventListener("pointermove", onMove);
    view.removeEventListener("pointerup", onUp);
    view.removeEventListener("pointercancel", onCancel);
    if (drop && destination) options.onDrop(fromPath, destination.dataset.path ?? "");
  };
  const onUp = (event: PointerEvent) => finish(event, true);
  const onCancel = (event: PointerEvent) => finish(event, false);
  const onDown = (event: PointerEvent) => {
    if (event.button !== 0 || !event.isPrimary || pointerId != null) return;
    pointerId = event.pointerId;
    startX = event.clientX;
    startY = event.clientY;
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

  source.addEventListener("pointerdown", onDown);
  source.addEventListener("click", onClick, true);
  return () => {
    source.removeEventListener("pointerdown", onDown);
    source.removeEventListener("click", onClick, true);
    clearTarget();
    view.removeEventListener("pointermove", onMove);
    view.removeEventListener("pointerup", onUp);
    view.removeEventListener("pointercancel", onCancel);
  };
}
