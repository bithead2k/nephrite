Nephrite activity rail and Preferences follow-on
=================================================

Apply after:
  1. nephrite-0.2-milestone.patch
  2. nephrite-0.2-startup-recovery.patch
  3. nephrite-toolbar-wrap-layout.patch

Commands:

  cd ~/play/nephrite
  patch -p1 < nephrite-activity-rail-preferences.patch
  npm run test:performance
  npm run build

Changes:

  - Moves Files, Search, Graph, Tasks, Bookmarks, Git, and Query Log to a
    permanent left activity rail.
  - Keeps the editor toolbar to one row: Today, Save, view mode, Draw,
    Canvas, and Template.
  - Restores file-panel Search and Collapse buttons.
  - Routes Ctrl+O through the Search Files button, expands the Files panel,
    focuses the file filter, and selects its current contents.
  - Adds a compact Preferences popover containing Open a vault, Vim mode,
    Show dotfiles, Open external links in browser, and Rescan Vault.
  - Persists the external-browser preference. When enabled, HTTP(S) links
    bypass Nephrite's embedded view and open in the system browser.

