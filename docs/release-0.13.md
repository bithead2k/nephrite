# Nephrite 0.13.0

`PROJECT_VERSION` 0.13 is a minor application release. Existing 0.12 indexes
remain compatible and reconcile in place; this release does not require a full
vault rebuild.

## Added Obsidian Sync

- Nephrite can install Obsidian Headless (`ob`), authenticate an Obsidian
  account without storing its credentials, connect the open local vault to a
  remote vault, and perform the initial sync.
- Optional continuous sync starts with Nephrite, stops when Nephrite exits, and
  reacts immediately when the setting changes.
- A provider-neutral sync boundary leaves room for peer-to-peer, Ring, GitHub,
  and other future methods without coupling the application lifecycle to `ob`.
- The command bar shows active sync with a blinking indicator, turns green when
  fully synced, and exposes errors without hiding them in a background process.
- Setup and runtime failures report actionable messages for missing Node.js,
  installation, authentication, vault discovery, configuration, and process
  startup problems.

## Safer compatibility

- Sync settings compare the policies independently reported by Obsidian, `ob`,
  and Nephrite, then explain attachment, configuration, exclusion, and conflict
  differences rather than silently treating one client as authoritative.
- Nephrite reads Obsidian's device-local policy without launching the Obsidian
  desktop application.
- New or renamed vault paths that fall outside the portable filename subset
  raise an alert naming the sync client that cannot represent the name and the
  specific reason.
- The filename check covers the colon behavior observed in `ob`, portable
  Windows and Android restrictions, reserved Windows device names, trailing
  dots and spaces, control characters, and overlong path components.

## Sync interaction improvements

- Successful authentication and settings changes provide visible confirmation.
- The settings action distinguishes initial setup from later changes: after the
  first sync it reads **Apply settings**.
- Existing `ob` configuration is diagnostic only and never silently overwrites
  Nephrite's chosen policy.

## Regression protection

- Native tests cover safe selective-sync defaults, credential-free settings
  persistence, Obsidian policy decoding, and portable filename validation.
- UI coverage exercises provider-neutral command-bar sync activity and success.
