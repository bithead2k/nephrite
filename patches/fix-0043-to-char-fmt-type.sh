#!/usr/bin/env bash
# Fix to_char residual: captures[2] is str; match needs &str.
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
old = "            let fmt = captures[2];"
new = "            let fmt = captures[2].as_str();"
if old not in text:
    if "let fmt = captures[2].as_str();" in text:
        print(f"ok: already fixed in {path}")
        sys.exit(0)
    print("error: pattern not found", file=sys.stderr)
    sys.exit(1)
text = text.replace(old, new, 1)
path.write_text(text)
print(f"ok: fixed fmt type in {path}")
PY
