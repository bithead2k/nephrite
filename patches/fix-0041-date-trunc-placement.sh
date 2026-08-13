#!/usr/bin/env bash
# Fix date_trunc residual placement in src-tauri/src/lib.rs
# - Removes any module-level (illegal) date_trunc block
# - Ensures the residual lives inside translate_page_sql_residual
set -euo pipefail

FILE="${1:-src-tauri/src/lib.rs}"
if [[ ! -f "$FILE" ]]; then
  echo "error: $FILE not found (run from repo root or pass path)" >&2
  exit 1
fi

python3 - "$FILE" <<'PY'
from pathlib import Path
import re
import sys

path = Path(sys.argv[1])
text = path.read_text()
original = text

fn = text.find("fn translate_page_sql_residual")
if fn < 0:
    print("error: translate_page_sql_residual not found", file=sys.stderr)
    sys.exit(1)

BLOCK = r"""    // date_trunc('unit', source) → SQLite date/strftime
    let date_trunc = regex::Regex::new(
        r"(?i)\bdate_trunc\s*\(\s*'([^']+)'\s*,\s*([^)]+?)\s*\)",
    )
    .map_err(|error| error.to_string())?;
    translated = date_trunc
        .replace_all(&translated, |captures: &regex::Captures<'_>| {
            let unit = captures[1].to_ascii_lowercase();
            let source = captures[2].trim();
            match unit.as_str() {
                "day" | "days" => format!("date({source})"),
                "month" | "months" => format!("strftime('%Y-%m-01', {source})"),
                "year" | "years" => format!("strftime('%Y-01-01', {source})"),
                "hour" | "hours" => format!("strftime('%Y-%m-%d %H:00:00', {source})"),
                _ => captures[0].to_string(),
            }
        })
        .into_owned();

"""

# Remove every date_trunc residual block that appears BEFORE the residual function.
head, tail = text[:fn], text[fn:]

def strip_date_trunc_blocks(s: str) -> str:
    # Comment + let ... into_owned();
    s = re.sub(
        r"[ \t]*// date_trunc\([^\n]*\n(?:.*\n)*?[ \t]*\.into_owned\(\);\n*",
        "",
        s,
    )
    s = re.sub(
        r"[ \t]*let date_trunc = regex::Regex::new\([\s\S]*?\.into_owned\(\);\n*",
        "",
        s,
    )
    return s

head = strip_date_trunc_blocks(head)
text = head + tail

# Re-find fn after head edit
fn = text.find("fn translate_page_sql_residual")
if fn < 0:
    print("error: residual fn disappeared after cleanup", file=sys.stderr)
    sys.exit(1)

body_start = fn
# End of residual function: next top-level fn after body, heuristic
# Find opening brace of residual and matching close is hard; insert by anchor instead.
rest = text[body_start:]

# If already correctly present inside residual, leave body alone
# (body is from residual fn to end of file for this check)
if "let date_trunc = regex::Regex::new" in rest:
    # Ensure it's not only a false positive in a test string — require translated =
    if "translated = date_trunc" in rest:
        path.write_text(text)
        print(f"ok: cleaned module scope; date_trunc already inside residual ({path})")
        sys.exit(0)

# Insert before DISTINCT residual or before lower_values_table_alias call
anchors = [
    "    // IS [NOT] DISTINCT FROM → SQLite null-safe IS / IS NOT\n",
    "    // IS [NOT] DISTINCT FROM -> SQLite null-safe IS / IS NOT\n",
    "    let not_distinct = regex::Regex::new",
    "    translated = lower_values_table_alias(&translated);\n",
]

inserted = False
for anchor in anchors:
    # Only replace first occurrence after residual fn starts
    idx = text.find(anchor, body_start)
    if idx < 0:
        continue
    text = text[:idx] + BLOCK + text[idx:]
    inserted = True
    break

if not inserted:
    path.write_text(text)  # still save cleanup
    print(
        "error: cleaned module-level junk, but could not find insert anchor "
        "inside residual (DISTINCT / lower_values). Insert 0041c snippet by hand.",
        file=sys.stderr,
    )
    sys.exit(2)

path.write_text(text)
print(f"ok: fixed date_trunc placement in {path}")
if text == original:
    print("(no net change)")
PY
