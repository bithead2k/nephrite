# Nephrite 0.15.0

`PROJECT_VERSION` 0.15 is a minor application release. The vault format and
index schema remain compatible; opening an existing 0.14 index does not require
a full rebuild.

## Scroll Reading / teleprompter mode

- Reads the normal rendered Markdown preview as a continuously scrolling page,
  preserving images, PDFs, Graphviz, Excalidraw, tables, code, and the existing
  preview rendering pipeline.
- Places subtle, fixed inward-pointing markers at the 40% reading plane while
  the document moves behind them.
- Offers WPM presets from 90 through 600. Up/Down steps the persistent speed,
  Space pauses or resumes, and Escape exits.
- Derives velocity from each rendered block's height and word count so WPM
  remains useful across font sizes, wrapping, and viewport widths. Velocity is
  smoothed between blocks; code defaults to 70% and tables to 65% of prose
  speed.
- Supports fullscreen, optional chrome-free presentation, and a persistent
  horizontal mirror that flips the complete presentation for physical
  teleprompter glass.
- Keeps the note read-only while active and restores the prior view, scroll
  position, window presentation, and input handling when reading ends. Entering
  Reading Mode never changes the Markdown file.

## Android phone workflow

- Opens an existing Obsidian vault directly from Android shared storage and
  keeps Nephrite's disposable index in app-private storage.
- Provides the narrow-screen essentials: browse, edit, preview, search, tasks,
  save, and a save-first handoff to the same note in Obsidian.
- Leaves synchronization to the installed Obsidian app for now. Mobile skips
  desktop-only plugin, automation, shell, Git CLI, and headless-sync runtimes.

See [Mobile port](mobile.md) for setup, storage behavior, and current platform
limitations.

## Validation

The Rust workspace tests, TypeScript/UI tests, production web build, and Linux
desktop release build cover this release. Android was built and exercised on a
Samsung Z Flip7; iOS security-scoped folder access remains future work.
