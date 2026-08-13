#!/usr/bin/env bash
# Fix to_char residual: use &captures[2] (&str), not .as_str() (unstable).
set -euo pipefail
FILE="${1:-src-tauri/src/lib.rs}"
if [[ ! -f "$FILE" ]]; then
  echo "error: $FILE not found" >&2
  exit 1
fi

python3 - "$FILE" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
text = path.read_text()

replacements = [
    ("            let fmt = captures[2].as_str();", "            let fmt = &captures[2];"),
    ("            let fmt = captures[2];", "            let fmt = &captures[2];"),
]

changed = False
for old, new in replacements:
    if old in text:
        text = text.replace(old, new, 1)
        changed = True
        break

if "let fmt = &captures[2];" in text and not changed:
    print(f"ok: already fixed in {path}")
    sys.exit(0)

if not changed:
    print("error: fmt assignment pattern not found", file=sys.stderr)
    sys.exit(1)

path.write_text(text)
print(f"ok: fixed fmt borrow in {path}")
PY
