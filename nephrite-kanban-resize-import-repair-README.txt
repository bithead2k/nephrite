Nephrite Kanban resize import repair

Apply after nephrite-kanban-resize-collapse-fix.patch:

  cd ~/play/nephrite
  patch -p1 < nephrite-kanban-resize-import-repair.patch
  npm run test:performance
  npm run build

Root cause:

The final-sizer delivery added calls to resizedKanbanLaneWidth, but its import
hunks did not land in the accumulated source. The undefined name was resolved
only when dragging a lane, so the UI loaded and showed the resize cursor while
every drag failed with ReferenceError.

This repair adds the missing import to both the application and its regression
test. It makes no other source changes.
