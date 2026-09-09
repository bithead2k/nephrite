# Application icons

`artwork/nephrite-icon-source.png` is the canonical transparent gemstone artwork.
Every application icon must derive from this master. Never flatten it onto a
black, white, or colored background, including mobile and store assets.

Run `npm run icons:generate` to regenerate all desktop, Windows Store, macOS,
Android, iOS, web, and favicon sizes. Generation requires Bash and ImageMagick;
the Tauri CLI supplies the platform sizes and ICO/ICNS containers. The generator
explicitly replaces platform PNG backgrounds with the transparent master.

`npm run icons:verify` requires only Node and runs before every frontend/desktop
build. It verifies the master and every PNG frame in PNG, ICO, and ICNS assets:
transparent borders, substantial transparent background, and visible artwork.
A single transparent pixel is insufficient. Platform launchers may apply their
own presentation; the shipped artwork must retain alpha throughout the pipeline.

Windows deployment uses a native `nephrite.exe` GUI executable. Start-menu and
taskbar shortcuts target that executable directly and use its embedded icon.
Do not wrap it with WSL, a shell, or VBScript. After replacing an icon, refresh
the shortcut's icon reference/cache as well as the installed executable.

The transparent master was extracted with the built-in image editing tool using
the instruction: remove the entire dark background, retain the centered green
gemstone, its facets and highlights, and output transparent RGBA edges without
a background square or halo. Future size generation is deterministic.
