/**
 * Lightweight event bus for Nephrite UI / automation.
 * Kanban (and later plugins) emit; listeners + board-local scripts react.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Handler = (payload: any) => void | Promise<void>;

const listeners = new Map<string, Set<Handler>>();

export function on(event: string, handler: Handler): () => void {
  let set = listeners.get(event);
  if (!set) {
    set = new Set();
    listeners.set(event, set);
  }
  set.add(handler);
  return () => set!.delete(handler);
}

export function off(event: string, handler: Handler) {
  listeners.get(event)?.delete(handler);
}

export async function emit(event: string, payload: unknown): Promise<void> {
  const set = listeners.get(event);
  if (!set || set.size === 0) return;
  for (const h of [...set]) {
    try {
      await h(payload);
    } catch (e) {
      console.error(`[hooks] ${event}`, e);
    }
  }
}

/** Well-known event names */
export const Events = {
  /** Card is leaving a swim lane (fires before board rewrite). */
  KanbanCardLeft: "kanban:card-left",
  /** Card landed in a swim lane (fires after board save). */
  KanbanCardMoved: "kanban:card-moved",
  KanbanCardChecked: "kanban:card-checked",
  NoteOpened: "note:opened",
  NoteSaved: "note:saved",
} as const;
