//! Phase-I Markdown fact extraction (regex/line based).
//! Not a write-back AST. Offsets are UTF-8 byte offsets.

use std::collections::BTreeMap;

#[derive(Debug, Default, Clone)]
pub struct MarkdownFacts {
    pub frontmatter_raw: Option<String>,
    pub frontmatter_json: Option<String>,
    pub properties: Vec<PropertyLeaf>,
    pub headings: Vec<HeadingFact>,
    pub links: Vec<LinkFact>,
    pub tags: Vec<TagFact>,
    pub tasks: Vec<TaskFact>,
    pub body_for_fts: String,
    pub heading_texts_for_fts: String,
}

#[derive(Debug, Clone)]
pub struct PropertyLeaf {
    pub prop_path: String,
    pub prop_key: String,
    pub value_type: String,
    pub value_text: Option<String>,
    pub value_num: Option<f64>,
    pub value_bool: Option<bool>,
    pub value_json: Option<String>,
    pub is_leaf: bool,
}

#[derive(Debug, Clone)]
pub struct HeadingFact {
    pub heading_id: i64,
    pub level: i64,
    pub text: String,
    pub slug: String,
    pub start_offset: i64,
    pub end_offset: Option<i64>,
    pub start_line: i64,
}

#[derive(Debug, Clone)]
pub struct LinkFact {
    pub link_id: i64,
    pub target_raw: String,
    pub target_heading: Option<String>,
    pub target_block: Option<String>,
    pub display_text: Option<String>,
    pub link_kind: String,
    pub is_embed: bool,
    pub start_offset: i64,
    pub end_offset: i64,
}

#[derive(Debug, Clone)]
pub struct TagFact {
    pub tag: String,
    pub tag_head: String,
    pub source: String,
    pub start_offset: Option<i64>,
    pub line: Option<i64>,
}

#[derive(Debug, Clone)]
pub struct TaskFact {
    pub task_id: i64,
    pub status: String,
    pub status_char: String,
    pub text: String,
    pub raw_line: String,
    pub line: i64,
    pub start_offset: i64,
    pub end_offset: i64,
    pub completed: bool,
    pub list_indent: i64,
    pub due: Option<String>,
    pub scheduled: Option<String>,
    pub start_date: Option<String>,
    pub done_date: Option<String>,
    pub created_date: Option<String>,
    pub priority: Option<String>,
    pub recurrence: Option<String>,
    pub tags_json: Option<String>,
}

pub fn parse_markdown(content: &str) -> MarkdownFacts {
    let mut facts = MarkdownFacts::default();
    let (body, fm_raw, fm_end) = split_frontmatter(content);

    if let Some(raw) = fm_raw {
        facts.frontmatter_raw = Some(raw.clone());
        let (json, leaves, fm_tags) = parse_simple_yaml(&raw);
        facts.frontmatter_json = Some(json);
        facts.properties = leaves;
        for t in fm_tags {
            facts.tags.push(TagFact {
                tag: t.clone(),
                tag_head: t.split('/').next().unwrap_or(&t).to_string(),
                source: "frontmatter".into(),
                start_offset: None,
                line: None,
            });
        }
    }

    let body_start = fm_end;
    parse_body(body, body_start, &mut facts);
    facts
}

fn split_frontmatter(content: &str) -> (&str, Option<String>, usize) {
    let bytes = content.as_bytes();
    if !content.starts_with("---") {
        return (content, None, 0);
    }
    // First line is ---
    let after_first = match content.find('\n') {
        Some(i) => i + 1,
        None => return (content, None, 0),
    };
    // Find closing ---
    let rest = &content[after_first..];
    for (line_start, line) in line_spans(rest) {
        let trimmed = line.trim_end_matches(['\r', '\n']);
        if trimmed == "---" || trimmed == "..." {
            let abs_end = after_first + line_start + line.len();
            let raw = content[after_first..after_first + line_start].to_string();
            let body = if abs_end < content.len() {
                &content[abs_end..]
            } else {
                ""
            };
            return (body, Some(raw), abs_end);
        }
        // Frontmatter must be at start; stop if we went too far without closer?
        let _ = bytes;
    }
    (content, None, 0)
}

fn line_spans(s: &str) -> impl Iterator<Item = (usize, &str)> + '_ {
    let mut start = 0;
    let b = s.as_bytes();
    std::iter::from_fn(move || {
        if start >= s.len() {
            return None;
        }
        let mut end = start;
        while end < b.len() && b[end] != b'\n' {
            end += 1;
        }
        if end < b.len() {
            end += 1; // include newline
        }
        let line = &s[start..end];
        let pos = start;
        start = end;
        Some((pos, line))
    })
}

fn parse_body(body: &str, body_start: usize, facts: &mut MarkdownFacts) {
    let mut heading_id = 0i64;
    let mut link_id = 0i64;
    let mut task_id = 0i64;
    let mut line_no = 0i64;
    let mut fts_body = String::new();
    let mut fts_headings = String::new();
    let mut open_headings: Vec<(i64, i64)> = Vec::new(); // (heading_id, level)

    for (rel_off, line_with_nl) in line_spans(body) {
        line_no += 1;
        let abs = (body_start + rel_off) as i64;
        let line = line_with_nl.trim_end_matches(['\r', '\n']);
        let line_end = abs + line_with_nl.len() as i64;

        // Headings
        if let Some((level, text)) = parse_heading(line) {
            // close previous same-or-shallower
            while let Some((_, lvl)) = open_headings.last() {
                if *lvl >= level {
                    let (hid, _) = open_headings.pop().unwrap();
                    if let Some(h) = facts.headings.iter_mut().find(|h| h.heading_id == hid) {
                        h.end_offset = Some(abs);
                    }
                } else {
                    break;
                }
            }
            heading_id += 1;
            let slug = slugify(&text);
            fts_headings.push_str(&text);
            fts_headings.push(' ');
            facts.headings.push(HeadingFact {
                heading_id,
                level,
                text: text.clone(),
                slug,
                start_offset: abs,
                end_offset: None,
                start_line: line_no,
            });
            open_headings.push((heading_id, level));
            fts_body.push_str(&text);
            fts_body.push('\n');
            extract_tags_and_links(line, abs, line_no, &mut link_id, facts);
            continue;
        }

        // Tasks
        if let Some(task) = parse_task_line(line, abs, line_end, line_no, task_id + 1) {
            task_id += 1;
            let mut t = task;
            t.task_id = task_id;
            fts_body.push_str(&t.text);
            fts_body.push('\n');
            extract_tags_and_links(line, abs, line_no, &mut link_id, facts);
            facts.tasks.push(t);
            continue;
        }

        fts_body.push_str(line);
        fts_body.push('\n');
        extract_tags_and_links(line, abs, line_no, &mut link_id, facts);
    }

    // close remaining headings at EOF
    let eof = (body_start + body.len()) as i64;
    for (hid, _) in open_headings {
        if let Some(h) = facts.headings.iter_mut().find(|h| h.heading_id == hid) {
            h.end_offset = Some(eof);
        }
    }

    facts.body_for_fts = fts_body;
    facts.heading_texts_for_fts = fts_headings;
}

fn parse_heading(line: &str) -> Option<(i64, String)> {
    let trimmed = line.trim_start();
    if !trimmed.starts_with('#') {
        return None;
    }
    let mut level = 0i64;
    for c in trimmed.chars() {
        if c == '#' {
            level += 1;
        } else {
            break;
        }
    }
    if level == 0 || level > 6 {
        return None;
    }
    let rest = trimmed[level as usize..].to_string();
    if !rest.is_empty() && !rest.starts_with(' ') && !rest.starts_with('\t') {
        // e.g. #tag not heading — require space after hashes for ATX-ish safety
        // Obsidian allows `#Heading` without space sometimes; require space for ATX
        if !rest.starts_with('#') {
            // `#foo` as tag-like; treat as heading only if space
            return None;
        }
    }
    let text = rest.trim().to_string();
    if text.is_empty() {
        return None;
    }
    // Must have whitespace after hashes
    let after_hashes = &trimmed[level as usize..];
    if after_hashes.is_empty() || !(after_hashes.starts_with(' ') || after_hashes.starts_with('\t'))
    {
        return None;
    }
    Some((level, text))
}

fn parse_task_line(
    line: &str,
    start: i64,
    end: i64,
    line_no: i64,
    _next_id: i64,
) -> Option<TaskFact> {
    let indent = line.chars().take_while(|c| *c == ' ' || *c == '\t').count() as i64;
    let trimmed = line.trim_start();
    // - [ ] / * [x] / + [/]
    let rest = if let Some(r) = trimmed.strip_prefix("- [") {
        r
    } else if let Some(r) = trimmed.strip_prefix("* [") {
        r
    } else if let Some(r) = trimmed.strip_prefix("+ [") {
        r
    } else {
        return None;
    };
    let status_char = rest.chars().next()?;
    let after = rest.get(1..)?;
    if !after.starts_with(']') {
        return None;
    }
    let text = after[1..].trim_start().to_string();
    let (status, completed) = match status_char {
        ' ' => ("todo", false),
        '/' | '-' => ("half", false),
        'x' | 'X' => ("done", true),
        _ => ("todo", false),
    };
    let tags: Vec<String> = text
        .split_whitespace()
        .filter_map(|word| word.strip_prefix('#'))
        .map(|tag| {
            tag.trim_matches(|c: char| !c.is_alphanumeric() && c != '/' && c != '-' && c != '_')
        })
        .filter(|tag| !tag.is_empty())
        .map(str::to_string)
        .collect();
    let due = task_date(&text, "📅");
    let scheduled = task_date(&text, "⏳");
    let start_date = task_date(&text, "🛫");
    let done_date = task_date(&text, "✅");
    let created_date = task_date(&text, "➕");
    let priority = task_priority(&text);
    let recurrence = task_recurrence(&text);
    Some(TaskFact {
        task_id: 0,
        status: status.into(),
        status_char: status_char.to_string(),
        text,
        raw_line: line.to_string(),
        line: line_no,
        start_offset: start,
        end_offset: end,
        completed,
        list_indent: indent,
        due,
        scheduled,
        start_date,
        done_date,
        created_date,
        priority,
        recurrence,
        tags_json: (!tags.is_empty()).then(|| {
            format!(
                "[{}]",
                tags.iter()
                    .map(|tag| format!("\"{}\"", tag.replace('"', "\\\"")))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }),
    })
}

fn task_date(text: &str, marker: &str) -> Option<String> {
    let rest = text.split_once(marker)?.1.trim_start();
    let candidate = rest.get(..10)?;
    let bytes = candidate.as_bytes();
    (bytes.len() == 10
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| index == 4 || index == 7 || byte.is_ascii_digit()))
    .then(|| candidate.to_string())
}

fn task_priority(text: &str) -> Option<String> {
    [
        ("🔺", "highest"),
        ("⏫", "high"),
        ("🔼", "medium"),
        ("🔽", "low"),
        ("⏬", "lowest"),
    ]
    .into_iter()
    .find_map(|(marker, priority)| text.contains(marker).then(|| priority.to_string()))
}

fn task_recurrence(text: &str) -> Option<String> {
    let rest = text.split_once("🔁")?.1.trim();
    let end = ["📅", "⏳", "🛫", "✅", "➕", "🔺", "⏫", "🔼", "🔽", "⏬"]
        .into_iter()
        .filter_map(|marker| rest.find(marker))
        .min()
        .unwrap_or(rest.len());
    let value = rest[..end].trim();
    (!value.is_empty()).then(|| value.to_string())
}

fn extract_tags_and_links(
    line: &str,
    line_abs: i64,
    line_no: i64,
    link_id: &mut i64,
    facts: &mut MarkdownFacts,
) {
    // Wikilinks / embeds: ![[...]] or [[...]]
    let bytes = line.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        let embed = bytes[i] == b'!' && i + 1 < bytes.len() && bytes[i + 1] == b'[';
        let start = if embed {
            i
        } else if bytes[i] == b'[' && i + 1 < bytes.len() && bytes[i + 1] == b'[' {
            i
        } else {
            i += 1;
            continue;
        };
        let open = if embed { i + 1 } else { i };
        if open + 1 >= bytes.len() || bytes[open] != b'[' || bytes[open + 1] != b'[' {
            i += 1;
            continue;
        }
        if let Some(close_rel) = find_close_wikilink(&line[open + 2..]) {
            let inner = &line[open + 2..open + 2 + close_rel];
            let end = open + 2 + close_rel + 2; // ]]
            let abs_start = line_abs + start as i64;
            let abs_end = line_abs + end as i64;
            *link_id += 1;
            let (target, display) = split_alias(inner);
            let (target_raw, heading, block) = split_heading_block(target);
            facts.links.push(LinkFact {
                link_id: *link_id,
                target_raw,
                target_heading: heading,
                target_block: block,
                display_text: display,
                link_kind: "wikilink".into(),
                is_embed: embed,
                start_offset: abs_start,
                end_offset: abs_end,
            });
            i = end;
            continue;
        }
        i += 1;
    }

    // Tags #foo / #foo/bar (not inside headings we already handled similarly)
    let mut chars = line.char_indices().peekable();
    while let Some((idx, c)) = chars.next() {
        if c != '#' {
            continue;
        }
        // previous char not word
        if idx > 0 {
            let prev = line[..idx].chars().last().unwrap_or(' ');
            if prev.is_alphanumeric() || prev == '_' {
                continue;
            }
        }
        let rest = &line[idx + 1..];
        let tag: String = rest
            .chars()
            .take_while(|ch| ch.is_alphanumeric() || *ch == '/' || *ch == '_' || *ch == '-')
            .collect();
        if tag.is_empty() || tag.starts_with('/') {
            continue;
        }
        // reject pure numbers?
        facts.tags.push(TagFact {
            tag: tag.clone(),
            tag_head: tag.split('/').next().unwrap_or(&tag).to_string(),
            source: "body".into(),
            start_offset: Some(line_abs + idx as i64),
            line: Some(line_no),
        });
    }
}

fn find_close_wikilink(s: &str) -> Option<usize> {
    s.find("]]")
}

fn split_alias(inner: &str) -> (&str, Option<String>) {
    if let Some((a, b)) = inner.split_once('|') {
        (a.trim(), Some(b.trim().to_string()))
    } else {
        (inner.trim(), None)
    }
}

fn split_heading_block(target: &str) -> (String, Option<String>, Option<String>) {
    // note#heading or note#^block or note#heading#^block (obsidian: note#heading or note#^block)
    if let Some((note, frag)) = target.split_once('#') {
        if let Some(block) = frag.strip_prefix('^') {
            return (note.to_string(), None, Some(block.to_string()));
        }
        // heading may contain further? keep simple
        if let Some((h, rest)) = frag.split_once('#') {
            if let Some(block) = rest.strip_prefix('^') {
                return (
                    note.to_string(),
                    Some(h.to_string()),
                    Some(block.to_string()),
                );
            }
        }
        return (note.to_string(), Some(frag.to_string()), None);
    }
    (target.to_string(), None, None)
}

fn slugify(text: &str) -> String {
    // Approximate Obsidian-style: lowercase, spaces to nothing special — keep readable
    text.trim()
        .chars()
        .map(|c| if c.is_whitespace() { ' ' } else { c })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// Very small YAML subset: `key: value` lines, nested indent maps, simple lists `- item`.
fn parse_simple_yaml(raw: &str) -> (String, Vec<PropertyLeaf>, Vec<String>) {
    let mut leaves: Vec<PropertyLeaf> = Vec::new();
    let mut tags: Vec<String> = Vec::new();
    let mut root: BTreeMap<String, YamlVal> = BTreeMap::new();
    let mut stack: Vec<(usize, String)> = vec![]; // indent → path prefix keys

    let lines = raw.lines().collect::<Vec<_>>();
    for (line_index, line) in lines.iter().enumerate() {
        if line.trim().is_empty() || line.trim_start().starts_with('#') {
            continue;
        }
        let indent = line.chars().take_while(|c| *c == ' ').count();
        let trimmed = line.trim();

        // list item
        if let Some(item) = trimmed.strip_prefix("- ") {
            let path = current_path(&stack);
            let val = parse_scalar(item.trim());
            if path.ends_with("tags") || path == "tags" {
                if let YamlVal::Str(s) = &val {
                    let t = s.trim_start_matches('#').to_string();
                    if !t.is_empty() {
                        tags.push(t);
                    }
                }
            }
            let prefix = if path.is_empty() {
                "_list".to_string()
            } else {
                path
            };
            let n = leaves
                .iter()
                .filter(|l| {
                    l.prop_path.starts_with(&format!("{prefix}["))
                        && !l.prop_path[prefix.len() + 1..].contains('.')
                })
                .count();
            let indexed = format!("{prefix}[{n}]");
            push_leaf(&mut leaves, &indexed, &val);
            append_nested(&mut root, &prefix, val);
            continue;
        }

        if let Some((k, v)) = trimmed.split_once(':') {
            let key = k.trim().to_string();
            if key.is_empty() {
                continue;
            }
            let v = v.trim();
            while stack.last().map(|(i, _)| *i >= indent).unwrap_or(false) {
                stack.pop();
            }
            let parent = current_path(&stack);
            let prop_path = if parent.is_empty() {
                key.clone()
            } else {
                format!("{parent}.{key}")
            };

            if v.is_empty() {
                let child = lines[line_index + 1..].iter().find(|candidate| {
                    !candidate.trim().is_empty() && !candidate.trim_start().starts_with('#')
                });
                let has_child = child
                    .map(|candidate| candidate.chars().take_while(|c| *c == ' ').count() > indent)
                    .unwrap_or(false);
                let val = if has_child {
                    stack.push((indent, key.clone()));
                    if child
                        .map(|candidate| candidate.trim_start().starts_with("- "))
                        .unwrap_or(false)
                    {
                        YamlVal::Arr(Vec::new())
                    } else {
                        YamlVal::Map(BTreeMap::new())
                    }
                } else {
                    YamlVal::Null
                };
                push_leaf(&mut leaves, &prop_path, &val);
                set_nested(&mut root, &prop_path, val);
            } else {
                let val = parse_scalar(v);
                if key == "tags" {
                    collect_tags_from_val(&val, &mut tags);
                }
                // last write wins for duplicate keys
                if let Some(pos) = leaves.iter().position(|l| l.prop_path == prop_path) {
                    leaves.remove(pos);
                }
                push_leaf(&mut leaves, &prop_path, &val);
                set_nested(&mut root, &prop_path, val);
            }
        }
    }

    let json = yaml_to_json(&YamlVal::Map(root));
    (json, leaves, tags)
}

fn current_path(stack: &[(usize, String)]) -> String {
    stack
        .iter()
        .map(|(_, k)| k.as_str())
        .collect::<Vec<_>>()
        .join(".")
}

#[derive(Debug, Clone)]
enum YamlVal {
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    Map(BTreeMap<String, YamlVal>),
    #[allow(dead_code)]
    Arr(Vec<YamlVal>),
}

fn parse_scalar(s: &str) -> YamlVal {
    let s = s.trim();
    if s == "null" || s == "~" || s.is_empty() {
        return YamlVal::Null;
    }
    if s == "true" {
        return YamlVal::Bool(true);
    }
    if s == "false" {
        return YamlVal::Bool(false);
    }
    if let Ok(n) = s.parse::<f64>() {
        return YamlVal::Num(n);
    }
    let unquoted = s
        .strip_prefix('"')
        .and_then(|x| x.strip_suffix('"'))
        .or_else(|| s.strip_prefix('\'').and_then(|x| x.strip_suffix('\'')))
        .unwrap_or(s);
    YamlVal::Str(unquoted.to_string())
}

fn push_leaf(leaves: &mut Vec<PropertyLeaf>, prop_path: &str, val: &YamlVal) {
    let prop_key = prop_path.rsplit(['.', '[']).next().unwrap_or(prop_path);
    let prop_key = prop_key.trim_end_matches(']').to_string();
    let (value_type, value_text, value_num, value_bool, value_json) = match val {
        YamlVal::Null => ("null".into(), None, None, None, Some("null".into())),
        YamlVal::Bool(b) => (
            "boolean".into(),
            Some(b.to_string()),
            None,
            Some(*b),
            Some(b.to_string()),
        ),
        YamlVal::Num(n) => (
            "number".into(),
            Some(n.to_string()),
            Some(*n),
            None,
            Some(n.to_string()),
        ),
        YamlVal::Str(s) => {
            let t = if s.starts_with("[[") {
                "link"
            } else {
                "string"
            };
            (
                t.into(),
                Some(s.clone()),
                None,
                None,
                Some(format!("\"{}\"", s.replace('\"', "\\\""))),
            )
        }
        YamlVal::Map(_) => ("object".into(), None, None, None, Some(yaml_to_json(val))),
        YamlVal::Arr(_) => ("array".into(), None, None, None, Some(yaml_to_json(val))),
    };
    leaves.push(PropertyLeaf {
        prop_path: prop_path.to_string(),
        prop_key,
        value_type,
        value_text,
        value_num,
        value_bool,
        value_json,
        is_leaf: !matches!(val, YamlVal::Map(_) | YamlVal::Arr(_)),
    });
}

fn set_nested(root: &mut BTreeMap<String, YamlVal>, path: &str, val: YamlVal) {
    let parts: Vec<&str> = path.split('.').collect();
    if parts.len() == 1 {
        root.insert(parts[0].to_string(), val);
        return;
    }
    // shallow: only set top-level for json blob simplicity
    // full nested map build:
    fn insert(map: &mut BTreeMap<String, YamlVal>, parts: &[&str], val: YamlVal) {
        if parts.len() == 1 {
            map.insert(parts[0].to_string(), val);
            return;
        }
        let e = map
            .entry(parts[0].to_string())
            .or_insert_with(|| YamlVal::Map(BTreeMap::new()));
        if !matches!(e, YamlVal::Map(_)) {
            *e = YamlVal::Map(BTreeMap::new());
        }
        if let YamlVal::Map(map) = e {
            insert(map, &parts[1..], val);
        }
    }
    insert(root, &parts, val);
}

fn append_nested(root: &mut BTreeMap<String, YamlVal>, path: &str, val: YamlVal) {
    let parts = path.split('.').collect::<Vec<_>>();
    fn append(map: &mut BTreeMap<String, YamlVal>, parts: &[&str], val: YamlVal) {
        if parts.len() == 1 {
            let entry = map
                .entry(parts[0].to_string())
                .or_insert_with(|| YamlVal::Arr(Vec::new()));
            if !matches!(entry, YamlVal::Arr(_)) {
                *entry = YamlVal::Arr(Vec::new());
            }
            if let YamlVal::Arr(items) = entry {
                items.push(val);
            }
            return;
        }
        let entry = map
            .entry(parts[0].to_string())
            .or_insert_with(|| YamlVal::Map(BTreeMap::new()));
        if !matches!(entry, YamlVal::Map(_)) {
            *entry = YamlVal::Map(BTreeMap::new());
        }
        if let YamlVal::Map(child) = entry {
            append(child, &parts[1..], val);
        }
    }
    if !parts.is_empty() {
        append(root, &parts, val);
    }
}

fn collect_tags_from_val(val: &YamlVal, tags: &mut Vec<String>) {
    match val {
        YamlVal::Str(s) => {
            for part in s.split(|c| c == ',' || c == ' ') {
                let t = part.trim().trim_start_matches('#');
                if !t.is_empty() {
                    tags.push(t.to_string());
                }
            }
        }
        YamlVal::Arr(a) => {
            for v in a {
                collect_tags_from_val(v, tags);
            }
        }
        _ => {}
    }
}

fn yaml_to_json(v: &YamlVal) -> String {
    match v {
        YamlVal::Null => "null".into(),
        YamlVal::Bool(b) => b.to_string(),
        YamlVal::Num(n) => n.to_string(),
        YamlVal::Str(s) => format!("\"{}\"", s.replace('\\', "\\\\").replace('\"', "\\\"")),
        YamlVal::Map(m) => {
            let parts: Vec<String> = m
                .iter()
                .map(|(k, v)| format!("\"{}\":{}", k, yaml_to_json(v)))
                .collect();
            format!("{{{}}}", parts.join(","))
        }
        YamlVal::Arr(a) => {
            let parts: Vec<String> = a.iter().map(yaml_to_json).collect();
            format!("[{}]", parts.join(","))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserves_nulls_lists_and_nested_objects_in_frontmatter_json() {
        let markdown = r#"---
work_email:
tags:
  - recruiter
  - linkedin
contact:
  website: https://example.com
---
"#;
        let facts = parse_markdown(markdown);
        let json: serde_json::Value =
            serde_json::from_str(facts.frontmatter_json.as_deref().unwrap()).unwrap();
        assert!(json["work_email"].is_null());
        assert_eq!(json["tags"], serde_json::json!(["recruiter", "linkedin"]));
        assert_eq!(json["contact"]["website"], "https://example.com");
    }

    #[test]
    fn extracts_heading_link_task_tag() {
        let md = r#"---
status: active
nested:
  rate: 10
tags:
  - work
---

# Hello

See ![[Other#Section]] and [[Note|alias]].

- [ ] Do thing #inbox
- [x] Done
"#;
        let f = parse_markdown(md);
        assert!(f.frontmatter_raw.is_some());
        assert!(f.headings.iter().any(|h| h.text == "Hello"));
        assert!(f
            .links
            .iter()
            .any(|l| l.is_embed && l.target_heading.as_deref() == Some("Section")));
        assert!(f
            .links
            .iter()
            .any(|l| l.display_text.as_deref() == Some("alias")));
        assert_eq!(f.tasks.len(), 2);
        assert!(f.tags.iter().any(|t| t.tag == "inbox"));
        assert!(f
            .tags
            .iter()
            .any(|t| t.tag == "work" && t.source == "frontmatter"));
        assert!(f.properties.iter().any(|p| p.prop_path == "status"));
        assert!(f.properties.iter().any(|p| p.prop_path == "nested.rate"));
    }

    #[test]
    fn extracts_obsidian_tasks_metadata_without_changing_task_text() {
        let line = "- [ ] Renew passport #admin ⏫ 🔁 every year ⏳ 2026-08-10 📅 2026-08-12";
        let facts = parse_markdown(line);
        let task = &facts.tasks[0];
        assert_eq!(
            task.text,
            "Renew passport #admin ⏫ 🔁 every year ⏳ 2026-08-10 📅 2026-08-12"
        );
        assert_eq!(task.priority.as_deref(), Some("high"));
        assert_eq!(task.recurrence.as_deref(), Some("every year"));
        assert_eq!(task.scheduled.as_deref(), Some("2026-08-10"));
        assert_eq!(task.due.as_deref(), Some("2026-08-12"));
        assert_eq!(task.tags_json.as_deref(), Some("[\"admin\"]"));
    }
}
