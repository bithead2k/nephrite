# Nephrite 0.14.0

`PROJECT_VERSION` 0.14 is a minor application release. The vault format and
index schema are unchanged; no vault rebuild or migration is required.

## Native Windows deployment

- Nephrite builds as a native Windows GUI executable using WebView2.
- Windows Start-menu and taskbar shortcuts launch `Nephrite.exe` directly.
- Replaces the WSL/shell launcher used in the initial downwarddog deployment,
  eliminating its console window and generic Linux/Tux taskbar entry.
- The executable carries the transparent Nephrite icon in its resources.

## Transparent application icons

- All 85 desktop, Windows Store, macOS, iOS, Android, and web icon assets derive
  from one transparent gemstone master, including all ICO/ICNS sizes.
- The generator preserves alpha when platform tooling would add a background.
- Every frontend/desktop build checks the master and embedded icon frames for
  transparent borders, substantial clear background, and visible artwork.
- See [Application icons](icons.md) for generation and maintenance instructions.

## Validation

Linux and Windows production builds and native Windows launch checks cover this
release. Mobile and macOS icon assets are validated; this does not claim runtime
testing or store publication on those platforms.
