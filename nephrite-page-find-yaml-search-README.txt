Nephrite page Find, Kanban lane collapse, and YAML-aware Vault Search
====================================================================

Apply after nephrite-activity-rail-preferences.patch:

  cd ~/play/nephrite
  patch -p1 < nephrite-page-find-yaml-search.patch

  cargo fmt --all
  cargo test --workspace
  cargo check --workspace
  npm run test:performance
  npm run build

Included behavior
-----------------

* Ctrl+F opens current-page Find from anywhere in the note workspace.
* Preview-only notes switch to Split so CodeMirror's match controls and
  highlights remain visible.
* Kanban Ctrl+F searches all source-backed card data, highlights matches,
  dims nonmatches, and collapses lanes with no matching card.
* Enter / Shift+Enter and the arrow buttons navigate Kanban matches.
* Empty Kanban lanes collapse by default to a 1em spine.
* Collapsed lane titles run bottom-to-top in American book-spine orientation.
* Clicking or keyboard-activating a collapsed spine expands it temporarily;
  activating it again collapses it.
* Search Vault now searches indexed YAML property paths, keys, and typed
  values in addition to the existing FTS body, heading, tag, and canvas data.
* YAML-only results show the matching property and open at its source line.
* Existing indexes work immediately; no Rescan Vault is required.

Validation
----------

* 32/32 TypeScript performance/rendering regressions pass.
* TypeScript compilation and the Vite production build pass.
* The YAML-property SQL was executed directly against SQLite with a
  company: Deloitte Consulting LLP regression fixture.
* A native Rust regression is included. Cargo is unavailable in the managed
  packaging runtime, so run the Cargo commands above on the development host.
