#!/usr/bin/env bash
# Insert to_char / strpos / position / substring residual into
# translate_page_sql_residual. Idempotent. Run from repo root.
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

fn = text.find("fn translate_page_sql_residual")
if fn < 0:
    print("error: translate_page_sql_residual not found", file=sys.stderr)
    sys.exit(1)

# Already present?
body = text[fn:]
if "let to_char = regex::Regex::new" in body and "let strpos = regex::Regex::new" in body:
    print(f"ok: already present in {path}")
    sys.exit(0)

BLOCK = r"""    // to_char(x, format) — common ISO-ish formats only
    let to_char = regex::Regex::new(
        r"(?i)\bto_char\s*\(\s*([^,]+?)\s*,\s*'([^']*)'\s*\)",
    )
    .map_err(|error| error.to_string())?;
    translated = to_char
        .replace_all(&translated, |captures: &regex::Captures<'_>| {
            let source = captures[1].trim();
            let fmt = captures[2];
            let sqlite_fmt = match fmt {
                "YYYY-MM-DD" | "yyyy-mm-dd" => "%Y-%m-%d",
                "YYYY-MM" | "yyyy-mm" => "%Y-%m",
                "YYYY" | "yyyy" => "%Y",
                "HH24:MI:SS" | "hh24:mi:ss" => "%H:%M:%S",
                "YYYY-MM-DD HH24:MI:SS" | "yyyy-mm-dd hh24:mi:ss" => "%Y-%m-%d %H:%M:%S",
                _ => "",
            };
            if sqlite_fmt.is_empty() {
                captures[0].to_string()
            } else {
                format!("strftime('{sqlite_fmt}', {source})")
            }
        })
        .into_owned();

    // strpos(haystack, needle) / position(needle in haystack) → instr
    let strpos = regex::Regex::new(
        r"(?i)\bstrpos\s*\(\s*([^,]+?)\s*,\s*([^)]+?)\s*\)",
    )
    .map_err(|error| error.to_string())?;
    translated = strpos
        .replace_all(&translated, |captures: &regex::Captures<'_>| {
            format!("instr({}, {})", captures[1].trim(), captures[2].trim())
        })
        .into_owned();
    let position = regex::Regex::new(
        r"(?i)\bposition\s*\(\s*([^)]+?)\s+IN\s+([^)]+?)\s*\)",
    )
    .map_err(|error| error.to_string())?;
    translated = position
        .replace_all(&translated, |captures: &regex::Captures<'_>| {
            format!("instr({}, {})", captures[2].trim(), captures[1].trim())
        })
        .into_owned();

    // substring(s from n for len) → substr(s, n, len); substring(s from n) → substr(s, n)
    let substr_for = regex::Regex::new(
        r"(?i)\bsubstring\s*\(\s*([^)]+?)\s+FROM\s+([^)]+?)\s+FOR\s+([^)]+?)\s*\)",
    )
    .map_err(|error| error.to_string())?;
    translated = substr_for
        .replace_all(&translated, |captures: &regex::Captures<'_>| {
            format!(
                "substr({}, {}, {})",
                captures[1].trim(),
                captures[2].trim(),
                captures[3].trim()
            )
        })
        .into_owned();
    let substr_from = regex::Regex::new(
        r"(?i)\bsubstring\s*\(\s*([^)]+?)\s+FROM\s+([^)]+?)\s*\)",
    )
    .map_err(|error| error.to_string())?;
    translated = substr_from
        .replace_all(&translated, |captures: &regex::Captures<'_>| {
            format!("substr({}, {})", captures[1].trim(), captures[2].trim())
        })
        .into_owned();

"""

anchors = [
    "    // date_trunc('unit', source) → SQLite date/strftime\n",
    "    // date_trunc('unit', source) -> SQLite date/strftime\n",
    "    // IS [NOT] DISTINCT FROM → SQLite null-safe IS / IS NOT\n",
    "    // IS [NOT] DISTINCT FROM -> SQLite null-safe IS / IS NOT\n",
    "    let not_distinct = regex::Regex::new",
    "    translated = lower_values_table_alias(&translated);\n",
]

inserted = False
for anchor in anchors:
    idx = text.find(anchor, fn)
    if idx < 0:
        continue
    text = text[:idx] + BLOCK + text[idx:]
    inserted = True
    print(f"inserted before anchor: {anchor.strip()[:48]!r}")
    break

if not inserted:
    print("error: no insert anchor found inside residual", file=sys.stderr)
    sys.exit(2)

path.write_text(text)
print(f"ok: updated {path}")
PY
