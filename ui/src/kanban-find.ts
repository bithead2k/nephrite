import type { KanbanCard, KanbanColumn } from "./kanban";

export type KanbanFindResult = {
  cardMatches: boolean[];
  matchingCards: number;
  collapse: boolean;
};

export function normalizePageFindQuery(query: string): string {
  return query.trim().toLocaleLowerCase();
}

/** Search every source-backed field, not only the label rendered on the card. */
export function kanbanCardSearchText(card: KanbanCard): string {
  return [card.raw, card.text, card.label, card.link ?? ""]
    .join("\n")
    .toLocaleLowerCase();
}

export function findInKanbanLane(
  column: KanbanColumn,
  query: string,
): KanbanFindResult {
  const needle = normalizePageFindQuery(query);
  const cardMatches = column.cards.map((card) =>
    needle.length > 0 && kanbanCardSearchText(card).includes(needle)
  );
  const matchingCards = cardMatches.filter(Boolean).length;
  return {
    cardMatches,
    matchingCards,
    collapse: column.cards.length === 0 || (needle.length > 0 && matchingCards === 0),
  };
}
