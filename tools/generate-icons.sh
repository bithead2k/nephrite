#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
master="$repo_root/artwork/nephrite-icon-source.png"
tauri_icons="$repo_root/src-tauri/icons"
web_icons="$repo_root/ui/src/assets/icons"

if ! command -v convert >/dev/null 2>&1; then
  echo "ImageMagick's convert command is required to generate Nephrite icons." >&2
  exit 1
fi

cd "$repo_root"
npm run tauri -- icon "$master"

# Tauri applies platform backgrounds to some mobile outputs. Preserve our
# transparent master at the exact dimensions of every generated PNG.
while IFS= read -r -d '' icon; do
  dimensions="$(identify -format '%wx%h' "$icon")"
  convert "$master" -filter Lanczos -resize "$dimensions" "PNG32:$icon"
done < <(find "$tauri_icons" -type f -name '*.png' -print0)

sizes=(16 20 24 29 32 36 40 48 57 58 60 64 72 76 80 87 96 114 120 128 144 152 167 180 192 256 384 512 1024)
for size in "${sizes[@]}"; do
  convert "$master" -filter Lanczos -resize "${size}x${size}" "$web_icons/nephrite-${size}x${size}.png"
done

cp "$web_icons/nephrite-16x16.png" "$web_icons/favicon-16x16.png"
cp "$web_icons/nephrite-32x32.png" "$web_icons/favicon-32x32.png"
cp "$web_icons/nephrite-180x180.png" "$web_icons/apple-touch-icon.png"
cp "$web_icons/nephrite-192x192.png" "$web_icons/android-chrome-192x192.png"
cp "$web_icons/nephrite-512x512.png" "$web_icons/android-chrome-512x512.png"
cp "$tauri_icons/icon.ico" "$web_icons/nephrite.ico"

node "$repo_root/tools/verify-icons.mjs"
