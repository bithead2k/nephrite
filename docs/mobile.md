# Mobile port: Android phone MVP

Nephrite Mobile is intended to open the same **local** Obsidian vault as the
Obsidian app. Obsidian remains the Sync client until Nephrite has its own sync
solution. Nephrite does not implement the Obsidian Sync protocol.

## Implemented

- The vault index can be opened at a caller-specified database path without
  creating a `.nephrite/` directory in the vault.
- Existing desktop calls still use `<vault>/.nephrite/index.db`; existing
  desktop caches are not moved, copied, or deleted.
- Android and iOS builds choose a per-vault database under Nephrite's private
  app-local data directory. The key is a hash of the resolved local vault path.
- Vault-open planning and offline-change verification use the same selected
  database location as vault opening.
- Android opens real shared-storage paths after the user grants All files
  access. It discovers Obsidian vaults under shared Documents and Obsidian
  folders, and also accepts an explicit existing absolute path.
- A narrow-screen workspace provides note browsing, editing, preview, search,
  tasks, save, and a save-first handoff to the installed Obsidian app. The
  handoff uses the open note's absolute path so Obsidian selects its containing
  local vault rather than guessing from the folder name. It never invokes
  Obsidian's Daily Notes creation action. Returning to Nephrite checks the vault
  for external changes.
- The Android runtime skips desktop plugin loading, automation lifecycle,
  headless Sync startup, and rejects shell/Git CLI commands. Obsidian remains
  the actual Sync client; Nephrite does not claim Sync status on phone.

The hash is only a disposable cache key, **not** the authoritative identity of
a vault. Moving a vault may cause a new index to be built from its files.

## Limitations

- iOS security-scoped folder access and bookmark persistence.
- Android's All files access is appropriate for sideloaded same-folder vault
  use, but Google Play distribution would require a policy declaration and
  review. A Storage Access Framework/content-URI backend is a separate port.
- External edits are reconciled on resume; saves use the current disk content
  as a conflict baseline. Do not edit the same note simultaneously in both
  apps. Sync is delegated to Obsidian and is not displayed as Nephrite status.
- Drawing, canvas, and advanced desktop/plugin workflows are not optimized for
  the phone. The first useful target is the Obsidian-like notes workflow.

## Build and install on an ARM64 Android phone

Install Android SDK/NDK, Java, the Rust `aarch64-linux-android` target, and the
Tauri CLI. For the current `pg_query` native build, point its C compiler and
binding generator at the NDK (substitute your installed paths):

```sh
ANDROID_HOME=/path/to/Android/Sdk \
NDK_HOME=/path/to/Android/Sdk/ndk/version \
JAVA_HOME=/path/to/jdk \
CC_aarch64_linux_android=/path/to/ndk/toolchains/llvm/prebuilt/linux-x86_64/bin/aarch64-linux-android24-clang \
CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER=/path/to/ndk/toolchains/llvm/prebuilt/linux-x86_64/bin/aarch64-linux-android24-clang \
BINDGEN_EXTRA_CLANG_ARGS='--target=aarch64-linux-android24 --sysroot=/path/to/ndk/toolchains/llvm/prebuilt/linux-x86_64/sysroot' \
npm exec tauri -- android build --apk --target aarch64
```

The release APK at
`src-tauri/gen/android/app/build/outputs/apk/universal/release/` is unsigned
unless a release signing key is configured. Sign it with your own key (a local
Android debug key is sufficient for a personal sideload), verify the APK
signature with `apksigner`, and install the signed APK with ADB.
At first launch, allow local file access in Android Settings, then select the
vault. The existing desktop cache remains at `<vault>/.nephrite/index.db` and
is untouched by the phone app.
