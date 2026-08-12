export const KANBAN_LANE_MIN_WIDTH = 180;
export const KANBAN_LANE_MAX_WIDTH = 600;
interface LaneResizeOptions {
  startWidth: number;
  pointerDelta: number;
}

function clampLaneWidth(width: number): number {
  return Math.max(KANBAN_LANE_MIN_WIDTH, Math.min(KANBAN_LANE_MAX_WIDTH, width));
}

export function resizedKanbanLaneWidth(options: LaneResizeOptions): number {
  return Math.round(clampLaneWidth(options.startWidth + options.pointerDelta));
}
