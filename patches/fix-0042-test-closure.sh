#!/usr/bin/env bash
set -euo pipefail
FILE="${1:-src-tauri/src/page_sql.rs}"
# Fix |_s| Ok(s.to_string()) -> |s| Ok(s.to_string())
if grep -q '|_s| Ok(s\.to_string())' "$FILE"; then
  sed -i 's/|_s| Ok(s\.to_string())/|s| Ok(s.to_string())/g' "$FILE"
  echo "fixed: $FILE"
else
  echo "pattern not found (maybe already fixed): $FILE"
fi
