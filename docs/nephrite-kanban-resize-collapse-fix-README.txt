Nephrite Kanban resize/collapse follow-on

Apply after nephrite-kanban-final-sizer.patch:

  cd ~/play/nephrite
  patch -p1 < nephrite-kanban-resize-collapse-fix.patch
  npm run test:performance
  npm run build

Changes:
- Tracks lane resizing at the window level, independent of collapsed siblings.
- Applies an explicit pixel width as well as flex basis.
- Removes sticky right-edge snapping; every pixel of drag changes the width.
- Disables only the separator belonging to a collapsed lane.
- Restores resize availability immediately when that lane is expanded.
- Preserves saved per-board widths and double-click reset.
