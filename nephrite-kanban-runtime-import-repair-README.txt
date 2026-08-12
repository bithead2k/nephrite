Nephrite Kanban runtime import repair

Apply after nephrite-kanban-resize-import-repair.patch:

  cd ~/play/nephrite
  patch -p1 < nephrite-kanban-runtime-import-repair.patch
  npm run test:performance
  npm run build

This replacement repair adds the missing resizedKanbanLaneWidth import to
ui/src/main.ts. It does not alter the test import or Kanban resize behavior.

Validated end state:

- 32/32 frontend regression tests pass.
- TypeScript compilation passes.
- Vite production build passes.
