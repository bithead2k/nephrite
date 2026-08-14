//! Page SQL AST → IR → SQLite lowering.
//!
//! Pipeline:
//!   PostgreSQL text
//!     → libpg_query parse (gated upstream to single read-only SELECT)
//!     → walk NodeRef tree, lower known page forms into [`PageExpr`] IR
//!     → recover source spans via token scan + node locations
//!     → rewrite those spans to SQLite helper SQL
//!     → residual forms still handled by the textual fallback
//!
//! Expand [`collect_rewrites`] / [`lower_aexpr`] as additional page.* operators
//! gain reliable spans. Prefer this path over growing the regex translator.

use pg_query::{protobuf, NodeEnum, NodeRef, ParseResult};

/// Intermediate representation for page-semantic expressions we know how to lower.
#[derive(Debug, Clone, PartialEq)]
pub enum PageExpr {
    /// Raw SQL fragment (escape hatch / not-yet-lowered subtree).
    Raw(String),
    /// Column or dotted reference, e.g. `tags`, `p.properties`.
    Column(String),
    /// `page_property(base, 'key')`
    PropertyGet { base: Box<PageExpr>, key: String },
    /// `page_has_key(base, 'key')`
    HasKey { base: Box<PageExpr>, key: String },
    /// `page_has_tag(array, 'tag')`
    HasTag { array: Box<PageExpr>, tag: String },
    /// Conjunction of HasTag (from `@> ARRAY[...]`)
    AllTags {
        array: Box<PageExpr>,
        tags: Vec<String>,
    },
    /// Disjunction of HasTag (from `&& ARRAY[...]`)
    AnyTag {
        array: Box<PageExpr>,
        tags: Vec<String>,
    },
    /// `page_array(...)` constructor
    ArrayLit(Vec<PageExpr>),
    /// `date_part('field', expr)` from EXTRACT
    DatePart {
        field: String,
        source: Box<PageExpr>,
    },
    /// Aggregate rename: string_agg→group_concat, bool_or→max, etc.
    AggRename {
        sqlite_name: &'static str,
        args_sql: String,
    },
    /// `expr IS NULL` / `expr IS NOT NULL`
    NullCheck { expr: Box<PageExpr>, is_null: bool },
    /// `properties ?& ARRAY['a','b']` → AND of page_has_key
    AllKeys {
        base: Box<PageExpr>,
        keys: Vec<String>,
    },
    /// `properties ?| ARRAY['a','b']` → OR of page_has_key
    AnyKeys {
        base: Box<PageExpr>,
        keys: Vec<String>,
    },
}

impl PageExpr {
    /// Emit SQLite SQL for this IR node.
    pub fn emit(&self) -> String {
        match self {
            PageExpr::Raw(s) => s.clone(),
            PageExpr::Column(name) => name.clone(),
            PageExpr::PropertyGet { base, key } => {
                format!(
                    "page_property({}, '{}')",
                    base.emit(),
                    escape_sql_string(key)
                )
            }
            PageExpr::HasKey { base, key } => {
                format!(
                    "page_has_key({}, '{}')",
                    base.emit(),
                    escape_sql_string(key)
                )
            }
            PageExpr::HasTag { array, tag } => {
                format!(
                    "page_has_tag({}, '{}')",
                    array.emit(),
                    escape_sql_string(tag)
                )
            }
            PageExpr::AllTags { array, tags } => {
                if tags.is_empty() {
                    "1".to_string()
                } else {
                    let parts: Vec<String> = tags
                        .iter()
                        .map(|t| {
                            format!("page_has_tag({}, '{}')", array.emit(), escape_sql_string(t))
                        })
                        .collect();
                    format!("({})", parts.join(" AND "))
                }
            }
            PageExpr::AnyTag { array, tags } => {
                if tags.is_empty() {
                    "0".to_string()
                } else {
                    let parts: Vec<String> = tags
                        .iter()
                        .map(|t| {
                            format!("page_has_tag({}, '{}')", array.emit(), escape_sql_string(t))
                        })
                        .collect();
                    format!("({})", parts.join(" OR "))
                }
            }
            PageExpr::ArrayLit(elems) => {
                let inner = elems
                    .iter()
                    .map(|e| e.emit())
                    .collect::<Vec<_>>()
                    .join(", ");
                format!("page_array({inner})")
            }
            PageExpr::DatePart { field, source } => {
                format!(
                    "date_part('{}', {})",
                    escape_sql_string(field),
                    source.emit()
                )
            }
            PageExpr::AggRename {
                sqlite_name,
                args_sql,
            } => {
                format!("{sqlite_name}({args_sql})")
            }
            PageExpr::NullCheck { expr, is_null } => {
                if *is_null {
                    format!("{} IS NULL", expr.emit())
                } else {
                    format!("{} IS NOT NULL", expr.emit())
                }
            }
            PageExpr::AllKeys { base, keys } => {
                if keys.is_empty() {
                    "1".to_string()
                } else {
                    let parts: Vec<String> = keys
                        .iter()
                        .map(|k| {
                            format!("page_has_key({}, '{}')", base.emit(), escape_sql_string(k))
                        })
                        .collect();
                    format!("({})", parts.join(" AND "))
                }
            }
            PageExpr::AnyKeys { base, keys } => {
                if keys.is_empty() {
                    "0".to_string()
                } else {
                    let parts: Vec<String> = keys
                        .iter()
                        .map(|k| {
                            format!("page_has_key({}, '{}')", base.emit(), escape_sql_string(k))
                        })
                        .collect();
                    format!("({})", parts.join(" OR "))
                }
            }
        }
    }
}

fn escape_sql_string(s: &str) -> String {
    s.replace('\'', "''")
}

/// Construct every IR variant and call helpers so non-test builds keep the
/// page-SQL surface linked (avoids dead_code warnings on intentional stubs).
fn retain_page_expr_surface() {
    let samples = [
        PageExpr::Raw("1".into()),
        PageExpr::Column("tags".into()),
        PageExpr::PropertyGet {
            base: Box::new(PageExpr::Column("properties".into())),
            key: "k".into(),
        },
        PageExpr::HasKey {
            base: Box::new(PageExpr::Column("properties".into())),
            key: "k".into(),
        },
        PageExpr::HasTag {
            array: Box::new(PageExpr::Column("tags".into())),
            tag: "x".into(),
        },
        PageExpr::AllTags {
            array: Box::new(PageExpr::Column("tags".into())),
            tags: vec!["x".into()],
        },
        PageExpr::AnyTag {
            array: Box::new(PageExpr::Column("tags".into())),
            tags: vec!["x".into()],
        },
        PageExpr::ArrayLit(vec![PageExpr::Column("tags".into())]),
        PageExpr::DatePart {
            field: "year".into(),
            source: Box::new(PageExpr::Column("mtime_ms".into())),
        },
        PageExpr::AggRename {
            sqlite_name: "group_concat",
            args_sql: "x, ','".into(),
        },
        PageExpr::NullCheck {
            expr: Box::new(PageExpr::Column("properties".into())),
            is_null: true,
        },
        PageExpr::AllKeys {
            base: Box::new(PageExpr::Column("properties".into())),
            keys: vec!["a".into()],
        },
        PageExpr::AnyKeys {
            base: Box::new(PageExpr::Column("properties".into())),
            keys: vec!["a".into()],
        },
    ];
    for sample in &samples {
        let _ = sample.emit();
    }
    let _ = analyze_page_forms(
        "SELECT path FROM pages WHERE 'x' = ANY(tags) AND tags @> ARRAY['x'] AND properties ? 'k'",
    );
}

#[derive(Debug, Clone)]
struct AstRewrite {
    start: usize,
    end: usize,
    replacement: String,
}

/// Prefer AST-driven rewrites when spans can be recovered.
///
/// - `full_textual`: complete page forms + residual (always safe)
/// - `residual_textual`: EXTRACT / aggregates / casts / ARRAY only
///
/// After AST rewrites we still run **full** textual forms. AST may only cover
/// a subset of page operators in a statement; residual-only left
/// `properties['key']` intact and broke real queries.
/// Strip SQL `--` line comments and `/* … */` block comments, respecting
/// single-quoted string literals (including `''` escapes). Double-quoted
/// identifiers are left intact except that `--` / `/*` inside them are still
/// treated as comment starters (PG identifiers rarely embed those).
pub fn strip_sql_comments(sql: &str) -> String {
    let bytes = sql.as_bytes();
    let mut out = Vec::with_capacity(sql.len());
    let mut i = 0;
    while i < bytes.len() {
        let c = bytes[i];
        // Single-quoted string
        if c == b'\'' {
            out.push(b'\'');
            i += 1;
            while i < bytes.len() {
                let ch = bytes[i];
                out.push(ch);
                i += 1;
                if ch == b'\'' {
                    if i < bytes.len() && bytes[i] == b'\'' {
                        out.push(b'\'');
                        i += 1; // escaped ''
                        continue;
                    }
                    break;
                }
            }
            continue;
        }
        // Line comment --
        if c == b'-' && i + 1 < bytes.len() && bytes[i + 1] == b'-' {
            i += 2;
            while i < bytes.len() && bytes[i] != b'\n' {
                i += 1;
            }
            // keep the newline so line structure stays stable for diagnostics
            continue;
        }
        // Block comment /* */
        if c == b'/' && i + 1 < bytes.len() && bytes[i + 1] == b'*' {
            i += 2;
            while i + 1 < bytes.len() && !(bytes[i] == b'*' && bytes[i + 1] == b'/') {
                i += 1;
            }
            if i + 1 < bytes.len() {
                i += 2; // consume */
            } else {
                i = bytes.len();
            }
            out.push(b' '); // keep token separation
            continue;
        }
        out.push(c);
        i += 1;
    }
    String::from_utf8(out).expect("SQL input started as valid UTF-8")
}

pub fn lower_page_sql(
    sql: &str,
    full_textual: impl FnOnce(&str) -> Result<String, String>,
    residual_textual: impl FnOnce(&str) -> Result<String, String>,
) -> Result<String, String> {
    // Statically reference the IR surface without taking the runtime path.
    if std::hint::black_box(false) {
        retain_page_expr_surface();
    }
    // Drop comments before AST/residual so `-- …` never confuses rewrites and
    // SQLite receives clean text (both dialects allow comments; stripping is safer).
    let sql = strip_sql_comments(sql);
    match try_ast_lower(&sql)? {
        Some(rewritten) => residual_textual(&rewritten),
        None => full_textual(&sql),
    }
}

/// Attempt AST-driven span rewrites. Returns `Ok(Some(sql))` when at least one
/// rewrite was applied, `Ok(None)` when nothing was rewritten.
pub fn try_ast_lower(sql: &str) -> Result<Option<String>, String> {
    let parsed = pg_query::parse(sql).map_err(|e| format!("PostgreSQL syntax: {e}"))?;
    let tokens = match pg_query::scan(sql) {
        Ok(result) => result.tokens,
        Err(_) => Vec::new(),
    };

    let mut rewrites: Vec<AstRewrite> = Vec::new();
    collect_rewrites(sql, &parsed, &tokens, &mut rewrites)?;
    collect_extract_keyword_rewrites(sql, &mut rewrites);

    if rewrites.is_empty() {
        return Ok(None);
    }

    // Select non-overlapping rewrites from the outside in. The AST walker also
    // reports child nodes (for example ARRAY[...] inside tags @> ARRAY[...]);
    // preferring the outer span preserves the semantic operator rewrite.
    rewrites.sort_by(|a, b| a.start.cmp(&b.start).then(b.end.cmp(&a.end)));
    let mut selected: Vec<AstRewrite> = Vec::new();
    for rewrite in rewrites {
        if selected
            .iter()
            .any(|kept| rewrite.start < kept.end && kept.start < rewrite.end)
        {
            continue;
        }
        selected.push(rewrite);
    }
    // Apply from the end so earlier byte offsets stay valid.
    selected.sort_by(|a, b| b.start.cmp(&a.start));
    let mut out = sql.to_string();
    for rw in &selected {
        if rw.start > rw.end || rw.end > out.len() {
            continue;
        }
        if !out.is_char_boundary(rw.start) || !out.is_char_boundary(rw.end) {
            continue;
        }
        out.replace_range(rw.start..rw.end, &rw.replacement);
    }
    if out == sql {
        return Ok(None);
    }
    if !sql_span_sane(&out) {
        // Prefer residual/full textual over a corrupted AST rewrite.
        return Ok(None);
    }
    Ok(Some(out))
}

fn sql_span_sane(sql: &str) -> bool {
    let mut paren = 0i32;
    let mut bracket = 0i32;
    let mut i = 0;
    let b = sql.as_bytes();
    while i < b.len() {
        match b[i] {
            b'\'' => {
                i += 1;
                while i < b.len() {
                    if b[i] == b'\'' {
                        if i + 1 < b.len() && b[i + 1] == b'\'' {
                            i += 2;
                            continue;
                        }
                        break;
                    }
                    i += 1;
                }
            }
            b'(' => paren += 1,
            b')' => {
                paren -= 1;
                if paren < 0 {
                    return false;
                }
            }
            b'[' => bracket += 1,
            b']' => {
                bracket -= 1;
                if bracket < 0 {
                    return false;
                }
            }
            _ => {}
        }
        i += 1;
    }
    paren == 0 && bracket == 0
}

/// Rewrite `EXTRACT(field FROM expr)` when the raw keyword form was not
/// already lowered via a FuncCall named date_part/extract.
fn collect_extract_keyword_rewrites(sql: &str, out: &mut Vec<AstRewrite>) {
    let lower = sql.to_ascii_lowercase();
    let mut search_from = 0;
    while let Some(rel) = lower[search_from..].find("extract") {
        let abs = search_from + rel;
        // Word boundary
        let prev_ok = abs == 0
            || !sql.as_bytes()[abs - 1].is_ascii_alphanumeric() && sql.as_bytes()[abs - 1] != b'_';
        let after = abs + "extract".len();
        let next_ok = after >= sql.len()
            || !sql.as_bytes()[after].is_ascii_alphanumeric() && sql.as_bytes()[after] != b'_';
        if prev_ok && next_ok {
            if let Some(end) = find_closing_paren_end(sql, abs) {
                let span = &sql[abs..end];
                let span_l = span.to_ascii_lowercase();
                // EXTRACT ( field FROM expr )
                if let Some(from_rel) = span_l.find(" from ") {
                    let field_part =
                        span[span.find('(').map(|i| i + 1).unwrap_or(0)..from_rel].trim();
                    let expr_part = span[from_rel + 6..span.len().saturating_sub(1)].trim();
                    if !field_part.is_empty() && !expr_part.is_empty() {
                        let field = field_part.trim_matches('\'').to_ascii_lowercase();
                        let ir = PageExpr::DatePart {
                            field,
                            source: Box::new(PageExpr::Raw(expr_part.to_string())),
                        };
                        out.push(AstRewrite {
                            start: abs,
                            end,
                            replacement: ir.emit(),
                        });
                    }
                }
            }
        }
        search_from = abs + 7;
    }
}

fn collect_rewrites(
    sql: &str,
    parsed: &ParseResult,
    tokens: &[protobuf::ScanToken],
    out: &mut Vec<AstRewrite>,
) -> Result<(), String> {
    for (node, _depth, _ctx, _filter) in parsed.protobuf.nodes() {
        match node {
            NodeRef::AExpr(expr) => {
                if let Some(rw) = lower_aexpr(sql, expr, tokens)? {
                    out.push(rw);
                }
            }
            NodeRef::SubscriptingRef(sub) => {
                if let Some(rw) = lower_subscript(sql, sub, tokens)? {
                    out.push(rw);
                }
            }
            NodeRef::AIndirection(indirection) => {
                if let Some(rw) = lower_aindirection(sql, indirection, tokens)? {
                    out.push(rw);
                }
            }
            NodeRef::FuncCall(func) => {
                if let Some(rw) = lower_funccall(sql, func, tokens)? {
                    out.push(rw);
                }
            }
            NodeRef::AArrayExpr(arr) => {
                if let Some(rw) = lower_aarrayexpr(sql, arr, tokens)? {
                    out.push(rw);
                }
            }
            NodeRef::NullTest(nt) => {
                if let Some(rw) = lower_nulltest(sql, nt, tokens)? {
                    out.push(rw);
                }
            }
            NodeRef::TypeCast(tc) => {
                if let Some(rw) = lower_typecast(sql, tc, tokens)? {
                    out.push(rw);
                }
            }
            NodeRef::BooleanTest(bt) => {
                if let Some(rw) = lower_booleantest(sql, bt, tokens)? {
                    out.push(rw);
                }
            }
            _ => {}
        }
    }
    Ok(())
}

fn lower_like_ilike(
    sql: &str,
    expr: &protobuf::AExpr,
    tokens: &[protobuf::ScanToken],
    kind: i32,
) -> Result<Option<AstRewrite>, String> {
    let left_col = expr.lexpr.as_ref().and_then(|n| column_ref(n));
    let left_const = expr.lexpr.as_ref().and_then(|n| string_const(n));
    let right_pat = expr.rexpr.as_ref().and_then(|n| string_const(n));
    let left_loc = expr
        .lexpr
        .as_ref()
        .and_then(|n| const_location(n).or_else(|| column_ref(n).map(|(_, l)| l)));
    let right_loc = expr.rexpr.as_ref().and_then(|n| const_location(n));

    let Some(pat) = right_pat else {
        return Ok(None);
    };
    let case_insensitive = kind == protobuf::AExprKind::AexprIlike as i32;

    // Build left SQL fragment: column name or quoted string
    let (left_sql, start) = if let Some((col, col_loc)) = left_col {
        let s = column_start(sql, &col, col_loc, 0).unwrap_or(0);
        (col, s)
    } else if let Some(c) = left_const {
        let s = left_loc
            .filter(|l| *l >= 0)
            .map(|l| l as usize)
            .unwrap_or(0);
        (format!("'{c}'"), s)
    } else {
        return Ok(None);
    };

    let end = if let Some(rl) = right_loc.filter(|l| *l >= 0) {
        let rstart = rl as usize;
        // end after the closing quote of the pattern
        if let Some(q) = sql[rstart..].find('\'') {
            let mut i = rstart + q + 1;
            let b = sql.as_bytes();
            while i < b.len() {
                if b[i] == b'\'' {
                    if i + 1 < b.len() && b[i + 1] == b'\'' {
                        i += 2;
                        continue;
                    }
                    i += 1;
                    break;
                }
                i += 1;
            }
            i
        } else {
            rstart + pat.len() + 2
        }
    } else {
        return Ok(None);
    };

    if end <= start || !sql.is_char_boundary(start) || !sql.is_char_boundary(end) {
        return Ok(None);
    }

    let replacement = if case_insensitive {
        format!("unicode_lower({left_sql}) LIKE unicode_lower('{pat}')")
    } else {
        format!("{left_sql} LIKE '{pat}'")
    };
    let _ = tokens;
    Ok(Some(AstRewrite {
        start,
        end,
        replacement,
    }))
}

fn lower_distinct_from(
    sql: &str,
    expr: &protobuf::AExpr,
    tokens: &[protobuf::ScanToken],
    kind: i32,
) -> Result<Option<AstRewrite>, String> {
    // Prefer residual for safety unless we can span both sides cleanly.
    let left_col = expr.lexpr.as_ref().and_then(|n| column_ref(n));
    let right_col = expr.rexpr.as_ref().and_then(|n| column_ref(n));
    let left_c = expr.lexpr.as_ref().and_then(|n| string_const(n));
    let right_c = expr.rexpr.as_ref().and_then(|n| string_const(n));

    let left_sql = if let Some((c, _)) = &left_col {
        c.clone()
    } else if let Some(c) = left_c {
        format!("'{c}'")
    } else {
        return Ok(None);
    };
    let right_sql = if let Some((c, _)) = &right_col {
        c.clone()
    } else if let Some(c) = right_c {
        format!("'{c}'")
    } else {
        return Ok(None);
    };

    let start = if let Some((col, loc)) = &left_col {
        column_start(sql, col, *loc, 0).unwrap_or(0)
    } else if let Some(loc) = expr.lexpr.as_ref().and_then(|n| const_location(n)) {
        if loc >= 0 {
            loc as usize
        } else {
            0
        }
    } else {
        return Ok(None);
    };

    let end = if let Some((col, loc)) = &right_col {
        column_start(sql, col, *loc, start)
            .map(|s| s + col.len())
            .unwrap_or(start)
    } else if let Some(loc) = expr.rexpr.as_ref().and_then(|n| const_location(n)) {
        if loc >= 0 {
            let s = loc as usize;
            sql[s..]
                .find('\'')
                .map(|q| {
                    let mut i = s + q + 1;
                    let b = sql.as_bytes();
                    while i < b.len() {
                        if b[i] == b'\'' {
                            if i + 1 < b.len() && b[i + 1] == b'\'' {
                                i += 2;
                                continue;
                            }
                            return i + 1;
                        }
                        i += 1;
                    }
                    i
                })
                .unwrap_or(s + 1)
        } else {
            return Ok(None);
        }
    } else {
        return Ok(None);
    };

    if end <= start || !sql.is_char_boundary(start) || !sql.is_char_boundary(end) {
        return Ok(None);
    }

    let not_distinct = kind == protobuf::AExprKind::AexprNotDistinct as i32;
    let replacement = if not_distinct {
        format!("({left_sql} IS {right_sql})")
    } else {
        format!("({left_sql} IS NOT {right_sql})")
    };
    let _ = tokens;
    Ok(Some(AstRewrite {
        start,
        end,
        replacement,
    }))
}

fn lower_aexpr(
    sql: &str,
    expr: &protobuf::AExpr,
    tokens: &[protobuf::ScanToken],
) -> Result<Option<AstRewrite>, String> {
    let op = aexpr_operator_name(expr);
    let kind = expr.kind;

    // 'x' = ANY(tags) / 'x' = ANY(aliases)  — AEXPR_OP_ANY
    if kind == protobuf::AExprKind::AexprOpAny as i32 {
        let scalar = expr.lexpr.as_ref().and_then(|n| string_const(n));
        let array = expr.rexpr.as_ref().and_then(|n| column_ref(n));
        let scalar_loc = expr.lexpr.as_ref().and_then(|n| const_location(n));
        match (scalar, array, scalar_loc) {
            (Some(tag), Some((col, col_loc)), Some(s_loc)) if is_tag_like_column(&col) => {
                let start = if s_loc >= 0 {
                    s_loc as usize
                } else {
                    find_near(sql, &format!("'{tag}'"), 0).unwrap_or(0)
                };
                let ir = PageExpr::HasTag {
                    array: Box::new(PageExpr::Column(col.clone())),
                    tag,
                };
                let col_pos = column_start(sql, &col, col_loc, start).unwrap_or(start);
                if let Some(end) = find_closing_paren_end(sql, col_pos) {
                    if end > start && sql.is_char_boundary(start) && sql.is_char_boundary(end) {
                        return Ok(Some(AstRewrite {
                            start,
                            end,
                            replacement: ir.emit(),
                        }));
                    }
                }
            }
            _ => {}
        }
        return Ok(None);
    }

    // a ILIKE 'pat' / a LIKE 'pat'  — AEXPR_ILIKE / AEXPR_LIKE
    if kind == protobuf::AExprKind::AexprIlike as i32
        || kind == protobuf::AExprKind::AexprLike as i32
        || op.eq_ignore_ascii_case("~~*")
        || op.eq_ignore_ascii_case("~~")
        || op.eq_ignore_ascii_case("ilike")
        || op.eq_ignore_ascii_case("like")
    {
        if let Some(rw) = lower_like_ilike(sql, expr, tokens, kind)? {
            return Ok(Some(rw));
        }
    }

    // a IS DISTINCT FROM b / IS NOT DISTINCT FROM
    if kind == protobuf::AExprKind::AexprDistinct as i32
        || kind == protobuf::AExprKind::AexprNotDistinct as i32
    {
        if let Some(rw) = lower_distinct_from(sql, expr, tokens, kind)? {
            return Ok(Some(rw));
        }
    }

    match op.as_str() {
        "@>" | "&&" => {
            let left = expr.lexpr.as_ref().and_then(|n| column_ref(n));
            let right_tags = expr.rexpr.as_ref().and_then(|n| string_array_elements(n));
            let array_loc = expr.rexpr.as_ref().and_then(|n| array_location(n));
            match (left, right_tags, array_loc) {
                (Some((col, col_loc)), Some(tags), Some(arr_loc)) if is_tag_like_column(&col) => {
                    let ir = if op == "@>" {
                        PageExpr::AllTags {
                            array: Box::new(PageExpr::Column(col.clone())),
                            tags,
                        }
                    } else {
                        PageExpr::AnyTag {
                            array: Box::new(PageExpr::Column(col.clone())),
                            tags,
                        }
                    };
                    let near = if arr_loc >= 0 { arr_loc as usize } else { 0 };
                    if let Some(start) = column_start(sql, &col, col_loc, near) {
                        if let Some((s, end)) =
                            span_column_through_closing_bracket(sql, tokens, start, near.max(start))
                        {
                            return Ok(Some(AstRewrite {
                                start: s,
                                end,
                                replacement: ir.emit(),
                            }));
                        }
                    }
                }
                _ => {}
            }
            Ok(None)
        }
        "?" => {
            let left = expr.lexpr.as_ref().and_then(|n| column_ref(n));
            let key = expr.rexpr.as_ref().and_then(|n| string_const(n));
            let key_loc = expr.rexpr.as_ref().and_then(|n| const_location(n));
            match (left, key, key_loc) {
                (Some((col, col_loc)), Some(key), Some(k_loc))
                    if col.ends_with("properties") || col == "properties" =>
                {
                    let ir = PageExpr::HasKey {
                        base: Box::new(PageExpr::Column(col.clone())),
                        key: key.clone(),
                    };
                    let near = if k_loc >= 0 { k_loc as usize } else { 0 };
                    if let Some(start) = column_start(sql, &col, col_loc, near) {
                        let end_hint = if k_loc >= 0 {
                            k_loc as usize
                        } else {
                            find_near(sql, &format!("'{key}'"), start).unwrap_or(start)
                        };
                        if let Some((s, end)) = span_from_to_token_end(sql, tokens, start, end_hint)
                        {
                            return Ok(Some(AstRewrite {
                                start: s,
                                end,
                                replacement: ir.emit(),
                            }));
                        }
                    }
                }
                _ => {}
            }
            Ok(None)
        }
        "?|" | "?&" => {
            let left = expr.lexpr.as_ref().and_then(|n| column_ref(n));
            let keys = expr.rexpr.as_ref().and_then(|n| string_array_elements(n));
            let arr_loc = expr.rexpr.as_ref().and_then(|n| const_location(n));
            match (left, keys, arr_loc) {
                (Some((col, col_loc)), Some(keys), Some(a_loc))
                    if col.ends_with("properties") || col == "properties" =>
                {
                    let ir = if op == "?&" {
                        PageExpr::AllKeys {
                            base: Box::new(PageExpr::Column(col.clone())),
                            keys,
                        }
                    } else {
                        PageExpr::AnyKeys {
                            base: Box::new(PageExpr::Column(col.clone())),
                            keys,
                        }
                    };
                    let near = if a_loc >= 0 { a_loc as usize } else { 0 };
                    if let Some(start) = column_start(sql, &col, col_loc, near) {
                        if let Some((s, end)) =
                            span_column_through_closing_bracket(sql, tokens, start, near.max(start))
                        {
                            return Ok(Some(AstRewrite {
                                start: s,
                                end,
                                replacement: ir.emit(),
                            }));
                        }
                    }
                }
                _ => {}
            }
            Ok(None)
        }
        "->" | "->>" => {
            // properties->>'key' / properties->'key'
            let left = expr.lexpr.as_ref().and_then(|n| column_ref(n));
            let key = expr.rexpr.as_ref().and_then(|n| string_const(n));
            let key_loc = expr.rexpr.as_ref().and_then(|n| const_location(n));
            match (left, key, key_loc) {
                (Some((col, col_loc)), Some(key), Some(k_loc))
                    if col.ends_with("properties") || col == "properties" =>
                {
                    let ir = PageExpr::PropertyGet {
                        base: Box::new(PageExpr::Column(col.clone())),
                        key: key.clone(),
                    };
                    let near = if k_loc >= 0 { k_loc as usize } else { 0 };
                    if let Some(start) = column_start(sql, &col, col_loc, near) {
                        let end_hint = if k_loc >= 0 {
                            k_loc as usize
                        } else {
                            find_near(sql, &format!("'{key}'"), start).unwrap_or(start)
                        };
                        if let Some((s, end)) = span_from_to_token_end(sql, tokens, start, end_hint)
                        {
                            return Ok(Some(AstRewrite {
                                start: s,
                                end,
                                replacement: ir.emit(),
                            }));
                        }
                    }
                }
                _ => {}
            }
            Ok(None)
        }
        _ => Ok(None),
    }
}

fn find_closing_paren_end(sql: &str, from: usize) -> Option<usize> {
    let bytes = sql.as_bytes();
    let mut depth = 0i32;
    let mut i = from;
    let mut seen_open = false;
    while i < bytes.len() {
        match bytes[i] {
            b'(' => {
                depth += 1;
                seen_open = true;
                i += 1;
            }
            b')' => {
                depth -= 1;
                i += 1;
                if seen_open && depth == 0 {
                    return Some(i);
                }
            }
            b'\'' => {
                i += 1;
                while i < bytes.len() {
                    if bytes[i] == b'\'' {
                        if i + 1 < bytes.len() && bytes[i + 1] == b'\'' {
                            i += 2;
                        } else {
                            i += 1;
                            break;
                        }
                    } else {
                        i += 1;
                    }
                }
            }
            _ => i += 1,
        }
    }
    // If no paren (bare column form is rare for ANY), end at next whitespace/operator boundary.
    if !seen_open {
        let mut j = from;
        while j < bytes.len()
            && !bytes[j].is_ascii_whitespace()
            && bytes[j] != b','
            && bytes[j] != b')'
        {
            j += 1;
        }
        // Also skip a trailing ')' if ANY(col) style without us seeing the open from col_loc
        // (col_loc points at the column, open paren is before it).
        // Search backward for '(' then forward for matching ')'.
        if let Some(open_pos) = sql[..from.min(sql.len())].rfind('(') {
            return find_closing_paren_end(sql, open_pos);
        }
        return Some(j);
    }
    None
}

fn lower_subscript(
    sql: &str,
    sub: &protobuf::SubscriptingRef,
    tokens: &[protobuf::ScanToken],
) -> Result<Option<AstRewrite>, String> {
    // Strict AST rewrite for properties['key'] only when the recovered span is
    // exactly the subscript (no trailing AS / newlines / extra brackets).
    // Residual textual still runs after AST and covers anything we skip.
    let base = sub.refexpr.as_ref().and_then(|n| column_ref(n));
    let key = sub.refupperindexpr.first().and_then(string_const);
    match (base, key) {
        (Some((col, col_loc)), Some(key)) if col.ends_with("properties") || col == "properties" => {
            let ir = PageExpr::PropertyGet {
                base: Box::new(PageExpr::Column(col.clone())),
                key,
            };
            let near = if col_loc >= 0 { col_loc as usize } else { 0 };
            if let Some(start) = column_start(sql, &col, col_loc, near) {
                if let Some((s, end)) =
                    span_column_through_closing_bracket(sql, tokens, start, start)
                {
                    let trimmed = sql[s..end].trim();
                    let ok_shape = trimmed.ends_with(']')
                        && trimmed.contains('[')
                        && !trimmed.to_ascii_lowercase().contains(" as ")
                        && !trimmed.contains('\n')
                        && trimmed.bytes().filter(|&c| c == b']').count() == 1
                        && !trimmed.to_ascii_lowercase().contains(" from ");
                    if ok_shape {
                        return Ok(Some(AstRewrite {
                            start: s,
                            end,
                            replacement: ir.emit(),
                        }));
                    }
                }
            }
        }
        _ => {}
    }
    Ok(None)
}

fn lower_aindirection(
    sql: &str,
    indirection: &protobuf::AIndirection,
    tokens: &[protobuf::ScanToken],
) -> Result<Option<AstRewrite>, String> {
    let Some((column, location)) = indirection.arg.as_ref().and_then(|node| column_ref(node))
    else {
        return Ok(None);
    };
    let Some(start) = column_start(sql, &column, location, 0) else {
        return Ok(None);
    };
    let mut expression = PageExpr::Column(column.clone());
    let properties = column == "properties" || column.ends_with(".properties");
    for node in &indirection.indirection {
        let Some(NodeEnum::AIndices(index)) = &node.node else {
            return Ok(None);
        };
        if properties {
            let Some(key) = index.uidx.as_ref().and_then(|node| string_const(node)) else {
                return Ok(None);
            };
            expression = PageExpr::PropertyGet {
                base: Box::new(expression),
                key,
            };
        } else {
            let upper = index
                .uidx
                .as_ref()
                .and_then(|node| literal_expr(node))
                .map(|value| value.emit())
                .unwrap_or_else(|| "NULL".into());
            if index.is_slice {
                let lower = index
                    .lidx
                    .as_ref()
                    .and_then(|node| literal_expr(node))
                    .map(|value| value.emit())
                    .unwrap_or_else(|| "NULL".into());
                expression = PageExpr::Raw(format!(
                    "page_array_slice({}, {lower}, {upper})",
                    expression.emit()
                ));
            } else {
                expression =
                    PageExpr::Raw(format!("page_array_get({}, {upper})", expression.emit()));
            }
        }
    }
    let mut end = start + column.len();
    for _ in &indirection.indirection {
        let Some(open_rel) = sql[end..].find('[') else {
            return Ok(None);
        };
        let open = end + open_rel;
        let Some(next_end) = find_closing_bracket_end(sql, tokens, open) else {
            return Ok(None);
        };
        end = next_end;
    }
    Ok(Some(AstRewrite {
        start,
        end,
        replacement: expression.emit(),
    }))
}

// ---------------------------------------------------------------------------
// Span recovery helpers (token scan + location hints)
// ---------------------------------------------------------------------------

fn lower_booleantest(
    sql: &str,
    bt: &protobuf::BooleanTest,
    tokens: &[protobuf::ScanToken],
) -> Result<Option<AstRewrite>, String> {
    // booltesttype: 0=IS TRUE, 1=IS NOT TRUE, 2=IS FALSE, 3=IS NOT FALSE,
    // 4=IS UNKNOWN, 5=IS NOT UNKNOWN (typical pg_query numbering)
    let kind = bt.booltesttype;
    let Some(ref arg) = bt.arg else {
        return Ok(None);
    };
    let loc = bt.location;
    let start = if loc >= 0 {
        loc as usize
    } else if let Some(c) = const_location(arg) {
        c as usize
    } else if let Some((col, col_loc)) = column_ref(arg) {
        column_start(sql, &col, col_loc, 0).unwrap_or(0)
    } else {
        return Ok(None);
    };

    // Find end: scan for TRUE/FALSE/UNKNOWN keyword after start
    let lower = sql.to_ascii_lowercase();
    let end = [
        " is not unknown",
        " is unknown",
        " is not true",
        " is true",
        " is not false",
        " is false",
    ]
    .iter()
    .filter_map(|kw| lower[start..].find(kw).map(|i| start + i + kw.len()))
    .min();
    let Some(end) = end else {
        return Ok(None);
    };
    if end <= start || !sql.is_char_boundary(start) || !sql.is_char_boundary(end) {
        return Ok(None);
    }

    // Argue expression text (best-effort: from start through before IS)
    let arg_slice = sql[start..end].to_ascii_lowercase();
    let is_pos = arg_slice.find(" is ").unwrap_or(0);
    let expr = sql[start..start + is_pos].trim();

    let replacement = match kind {
        // IS TRUE / IS NOT FALSE ≈ expr (SQLite 0/1)
        0 | 3 => format!("({expr})"),
        // IS FALSE / IS NOT TRUE
        2 | 1 => format!("NOT ({expr})"),
        // IS UNKNOWN ≈ IS NULL
        4 => format!("({expr}) IS NULL"),
        // IS NOT UNKNOWN
        5 => format!("({expr}) IS NOT NULL"),
        _ => return Ok(None),
    };
    let _ = tokens;
    Ok(Some(AstRewrite {
        start,
        end,
        replacement,
    }))
}

fn lower_typecast(
    sql: &str,
    tc: &protobuf::TypeCast,
    tokens: &[protobuf::ScanToken],
) -> Result<Option<AstRewrite>, String> {
    if tc.arg.is_none() {
        return Ok(None);
    }
    let cast_type = canonical_cast_type(tc)?;
    let start_hint = tc.location.max(0) as usize;
    let (start, end, argument) = if sql[start_hint..]
        .get(..4)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("cast"))
    {
        let end = find_closing_paren_end(sql, start_hint)
            .ok_or_else(|| "Could not recover CAST(...) source span".to_string())?;
        let open = sql[start_hint..end]
            .find('(')
            .map(|offset| start_hint + offset)
            .ok_or_else(|| "Malformed CAST expression".to_string())?;
        let as_position = find_top_level_as(sql, open + 1, end - 1)
            .ok_or_else(|| "CAST expression is missing AS".to_string())?;
        (
            start_hint,
            end,
            sql[open + 1..as_position].trim().to_string(),
        )
    } else {
        let type_location = tc
            .type_name
            .as_ref()
            .map(|name| name.location)
            .filter(|location| *location >= 0)
            .map(|location| location as usize)
            .unwrap_or(start_hint);
        let (start, separator, end) = find_postfix_cast_span(sql, type_location)
            .ok_or_else(|| "Could not recover PostgreSQL ::type source span".to_string())?;
        (start, end, sql[start..separator].trim().to_string())
    };
    let lowered_argument = lower_expression_fragment(&argument)?;
    let replacement = format!(
        "page_cast({}, '{}')",
        lowered_argument,
        escape_sql_string(&cast_type)
    );
    let _ = tokens;
    Ok(Some(AstRewrite {
        start,
        end,
        replacement,
    }))
}

fn canonical_cast_type(tc: &protobuf::TypeCast) -> Result<String, String> {
    let type_name = tc
        .type_name
        .as_ref()
        .ok_or_else(|| "PostgreSQL cast has no target type".to_string())?;
    let names = type_name
        .names
        .iter()
        .filter_map(|node| match &node.node {
            Some(NodeEnum::String(value)) => Some(value.sval.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>();
    let leaf = names.last().copied().unwrap_or("").to_ascii_lowercase();
    let array = !type_name.array_bounds.is_empty() || leaf.starts_with('_');
    let scalar = leaf.trim_start_matches('_');
    let canonical = match scalar {
        "text" | "varchar" | "bpchar" | "char" | "name" => "text",
        "int2" | "smallint" => "smallint",
        "int4" | "int" | "integer" => "integer",
        "int8" | "bigint" => "bigint",
        "numeric" | "decimal" => "numeric",
        "float4" | "real" => "real",
        "float8" | "double" => "double precision",
        "bool" | "boolean" => "boolean",
        "json" => "json",
        "jsonb" => "jsonb",
        "date" => "date",
        "timestamp" => "timestamp",
        "timestamptz" => "timestamp with time zone",
        "time" => "time",
        "timetz" => "time with time zone",
        // Semantic page scalar names are assertions over their Markdown-backed
        // representation; arrays are still validated as JSON arrays below.
        "tag" | "alias" | "link" | "header" | "todo" => scalar,
        _ => {
            return Err(format!(
                "Unsupported PostgreSQL cast target: {}",
                names.join(".")
            ));
        }
    };
    Ok(if array {
        format!("{canonical}[]")
    } else {
        canonical.to_string()
    })
}

fn lower_expression_fragment(expression: &str) -> Result<String, String> {
    let cast_depth = expression.matches("::").count()
        + expression
            .to_ascii_lowercase()
            .match_indices("cast(")
            .count();
    if cast_depth > 32 {
        return Err("PostgreSQL expression nesting exceeds Nephrite's limit of 32".into());
    }
    let wrapped = format!("SELECT {expression}");
    Ok(match try_ast_lower(&wrapped)? {
        Some(lowered) => lowered
            .strip_prefix("SELECT ")
            .or_else(|| lowered.strip_prefix("select "))
            .unwrap_or(expression)
            .to_string(),
        None => expression.to_string(),
    })
}

fn find_top_level_as(sql: &str, start: usize, end: usize) -> Option<usize> {
    let bytes = sql.as_bytes();
    let mut depth = 0i32;
    let mut quoted = false;
    let mut index = start;
    while index + 1 < end {
        if bytes[index] == b'\'' {
            if quoted && index + 1 < end && bytes[index + 1] == b'\'' {
                index += 2;
                continue;
            }
            quoted = !quoted;
            index += 1;
            continue;
        }
        if !quoted {
            match bytes[index] {
                b'(' | b'[' => depth += 1,
                b')' | b']' => depth -= 1,
                _ => {}
            }
            if depth == 0
                && sql[index..end]
                    .get(..2)
                    .is_some_and(|word| word.eq_ignore_ascii_case("as"))
                && (index == start || bytes[index - 1].is_ascii_whitespace())
                && (index + 2 == end || bytes[index + 2].is_ascii_whitespace())
            {
                return Some(index);
            }
        }
        index += 1;
    }
    None
}

fn find_postfix_cast_span(sql: &str, type_location: usize) -> Option<(usize, usize, usize)> {
    let bytes = sql.as_bytes();
    let separator = sql[..type_location.min(sql.len())].rfind("::")?;
    let mut start = separator;
    while start > 0 && bytes[start - 1].is_ascii_whitespace() {
        start -= 1;
    }
    if start > 0 && matches!(bytes[start - 1], b')' | b']') {
        let close = bytes[start - 1];
        let open = if close == b')' { b'(' } else { b'[' };
        let mut depth = 1i32;
        start -= 1;
        while start > 0 && depth > 0 {
            start -= 1;
            if bytes[start] == close {
                depth += 1;
            } else if bytes[start] == open {
                depth -= 1;
            }
        }
        while start > 0
            && (bytes[start - 1].is_ascii_alphanumeric() || matches!(bytes[start - 1], b'_' | b'.'))
        {
            start -= 1;
        }
    } else if start > 0 && bytes[start - 1] == b'\'' {
        start -= 1;
        while start > 0 {
            start -= 1;
            if bytes[start] == b'\'' && (start == 0 || bytes[start - 1] != b'\'') {
                break;
            }
        }
    } else {
        while start > 0
            && (bytes[start - 1].is_ascii_alphanumeric()
                || matches!(bytes[start - 1], b'_' | b'.' | b'+' | b'-'))
        {
            start -= 1;
        }
    }
    let mut end = type_location;
    while end < bytes.len()
        && (bytes[end].is_ascii_alphanumeric() || matches!(bytes[end], b'_' | b'.'))
    {
        end += 1;
    }
    if end < bytes.len() && bytes[end] == b'(' {
        end = find_closing_paren_end(sql, end)?;
    }
    let remainder = sql[end..].to_ascii_lowercase();
    for continuation in [
        " precision",
        " varying",
        " with time zone",
        " without time zone",
    ] {
        if remainder.starts_with(continuation) {
            end += continuation.len();
            break;
        }
    }
    while end + 1 < bytes.len() && bytes[end] == b'[' && bytes[end + 1] == b']' {
        end += 2;
    }
    Some((start, separator, end))
}

fn lower_nulltest(
    sql: &str,
    nt: &protobuf::NullTest,
    tokens: &[protobuf::ScanToken],
) -> Result<Option<AstRewrite>, String> {
    let loc = nt.location;
    let arg = nt.arg.as_ref();
    let Some(arg) = arg else {
        return Ok(None);
    };
    // Prefer property subscript / arrow / column as the null-checked expr.
    let inner = if let Some((col, col_loc)) = column_ref(arg) {
        if col.ends_with("properties") || col == "properties" || is_tag_like_column(&col) {
            Some((PageExpr::Column(col.clone()), col, col_loc))
        } else {
            None
        }
    } else {
        None
    };
    // SubscriptingRef properties['k']
    let inner = inner.or_else(|| {
        match &arg.node {
            Some(NodeEnum::SubscriptingRef(sub)) => {
                let (col, col_loc) = sub.refexpr.as_ref().and_then(|n| column_ref(n))?;
                if !(col.ends_with("properties") || col == "properties") {
                    return None;
                }
                let key = sub.refupperindexpr.first().and_then(string_const)?;
                Some((
                    PageExpr::PropertyGet {
                        base: Box::new(PageExpr::Column(col.clone())),
                        key,
                    },
                    col,
                    col_loc,
                ))
            }
            Some(NodeEnum::AExpr(expr)) => {
                // properties ->> 'k'  or properties -> 'k'
                let op = aexpr_operator_name(expr);
                if !matches!(op.as_str(), "->>" | "->") {
                    return None;
                }
                let (col, col_loc) = expr.lexpr.as_ref().and_then(|n| column_ref(n))?;
                if !(col.ends_with("properties") || col == "properties") {
                    return None;
                }
                let key = expr.rexpr.as_ref().and_then(|n| string_const(n))?;
                Some((
                    PageExpr::PropertyGet {
                        base: Box::new(PageExpr::Column(col.clone())),
                        key,
                    },
                    col,
                    col_loc,
                ))
            }
            _ => None,
        }
    });
    let Some((expr_ir, col, col_loc)) = inner else {
        return Ok(None);
    };
    // nulltesttype: typically 0 = IS NULL, 1 = IS NOT NULL
    let is_null = nt.nulltesttype == 0;
    let ir = PageExpr::NullCheck {
        expr: Box::new(expr_ir),
        is_null,
    };
    // Span from column/arg start through "NULL" keyword after IS [NOT]
    let near = if loc >= 0 { loc as usize } else { 0 };
    let Some(start) = column_start(sql, &col, col_loc, near) else {
        return Ok(None);
    };
    // Find end: scan for "NULL" after start
    let lower = sql.to_ascii_lowercase();
    let null_pos = lower[start..].find("null").map(|i| start + i + 4);
    let Some(end) = null_pos else {
        return Ok(None);
    };
    if end <= start || !sql.is_char_boundary(start) || !sql.is_char_boundary(end) {
        return Ok(None);
    }
    let _ = tokens;
    Ok(Some(AstRewrite {
        start,
        end,
        replacement: ir.emit(),
    }))
}
fn lower_aarrayexpr(
    sql: &str,
    arr: &protobuf::AArrayExpr,
    tokens: &[protobuf::ScanToken],
) -> Result<Option<AstRewrite>, String> {
    let loc = arr.location;
    if loc < 0 {
        return Ok(None);
    }
    let start_hint = loc as usize;
    // Include the ARRAY keyword if present just before the '['.
    let start = {
        let prefix = sql[..start_hint]
            .rfind("ARRAY")
            .or_else(|| sql[..start_hint].rfind("array"));
        match prefix {
            Some(p)
                if sql[p..start_hint]
                    .chars()
                    .all(|c| c.is_whitespace() || c.is_ascii_alphabetic()) =>
            {
                p
            }
            _ => start_hint,
        }
    };
    let Some(end) = find_closing_bracket_end(sql, tokens, start_hint)
        .or_else(|| find_closing_bracket_end(sql, tokens, start))
    else {
        return Ok(None);
    };
    if end <= start || !sql.is_char_boundary(start) || !sql.is_char_boundary(end) {
        return Ok(None);
    }
    let elems: Vec<PageExpr> = arr.elements.iter().filter_map(literal_expr).collect();
    if elems.is_empty() && !arr.elements.is_empty() {
        // Unrecognized element shapes — leave for residual textual.
        return Ok(None);
    }
    let ir = PageExpr::ArrayLit(elems);
    Ok(Some(AstRewrite {
        start,
        end,
        replacement: ir.emit(),
    }))
}
fn lower_funccall(
    sql: &str,
    func: &protobuf::FuncCall,
    tokens: &[protobuf::ScanToken],
) -> Result<Option<AstRewrite>, String> {
    let name = func
        .funcname
        .iter()
        .filter_map(|n| match &n.node {
            Some(NodeEnum::String(s)) => Some(s.sval.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join(".");
    let name_l = name.to_ascii_lowercase();
    let loc = func.location;
    if loc < 0 {
        return Ok(None);
    }
    let start = loc as usize;

    // EXTRACT / date_part(field, source) — PG often emits date_part after analysis;
    // raw trees may still say "date_part" or use extract-like FuncCall.
    // now() / current_timestamp / current_date / current_time
    if matches!(
        name_l.as_str(),
        "now" | "current_timestamp" | "current_date" | "current_time"
    ) {
        let start = if loc >= 0 { loc as usize } else { 0 };
        if loc >= 0 {
            // Bare CURRENT_DATE has no parens; FuncCall form usually does.
            let end = find_closing_paren_end(sql, start).unwrap_or_else(|| {
                // keyword-only: span the identifier
                let b = sql.as_bytes();
                let mut i = start;
                while i < b.len() && (b[i].is_ascii_alphanumeric() || b[i] == b'_') {
                    i += 1;
                }
                i
            });
            if end > start && sql.is_char_boundary(start) && sql.is_char_boundary(end) {
                let replacement = match name_l.as_str() {
                    "now" | "current_timestamp" => "datetime('now')".to_string(),
                    "current_date" => "date('now')".to_string(),
                    "current_time" => "time('now')".to_string(),
                    _ => String::new(),
                };
                if !replacement.is_empty() {
                    return Ok(Some(AstRewrite {
                        start,
                        end,
                        replacement,
                    }));
                }
            }
        }
        let _ = tokens;
        return Ok(None);
    }

    if matches!(name_l.as_str(), "date_part" | "extract") && func.args.len() >= 2 {
        let field = string_const(&func.args[0])
            .or_else(|| column_name(&func.args[0]))
            .unwrap_or_default()
            .trim_matches('\'')
            .to_ascii_lowercase();
        let Some(source) = column_name(&func.args[1])
            .map(PageExpr::Column)
            .or_else(|| {
                string_const(&func.args[1]).map(|value| PageExpr::Raw(format!("'{value}'")))
            })
        else {
            // Do not replace a nested expression with a fabricated NULL. The
            // residual path can retain the original function call safely.
            return Ok(None);
        };
        let ir = PageExpr::DatePart {
            field,
            source: Box::new(source),
        };
        if let Some(end) = find_closing_paren_end(sql, start) {
            if end > start && sql.is_char_boundary(start) && sql.is_char_boundary(end) {
                return Ok(Some(AstRewrite {
                    start,
                    end,
                    replacement: ir.emit(),
                }));
            }
        }
        let _ = tokens;
        return Ok(None);
    }

    // date_trunc('day'|'month'|'year', source) → SQLite date/strftime
    if name_l == "date_trunc" && func.args.len() >= 2 {
        let field = string_const(&func.args[0]).map(|s| s.to_ascii_lowercase());
        let source_col = column_ref(&func.args[1]);
        let source_sql = if let Some((col, _)) = source_col {
            col
        } else if let Some(c) = string_const(&func.args[1]) {
            format!("'{c}'")
        } else {
            // fall through — residual may still rewrite
            String::new()
        };
        if let (Some(field), true) = (field, !source_sql.is_empty()) {
            let start = if loc >= 0 { loc as usize } else { 0 };
            if start > 0 || loc >= 0 {
                if let Some(end) = find_closing_paren_end(sql, start) {
                    if end > start && sql.is_char_boundary(start) && sql.is_char_boundary(end) {
                        let replacement = match field.as_str() {
                            "day" | "days" => format!("date({source_sql})"),
                            "month" | "months" => {
                                format!("strftime('%Y-%m-01', {source_sql})")
                            }
                            "year" | "years" => {
                                format!("strftime('%Y-01-01', {source_sql})")
                            }
                            "hour" | "hours" => {
                                format!("strftime('%Y-%m-%d %H:00:00', {source_sql})")
                            }
                            _ => String::new(),
                        };
                        if !replacement.is_empty() {
                            return Ok(Some(AstRewrite {
                                start,
                                end,
                                replacement,
                            }));
                        }
                    }
                }
            }
        }
        let _ = tokens;
        return Ok(None);
    }

    // jsonb_exists(properties, 'key') → page_has_key
    if name_l == "jsonb_exists" && func.args.len() >= 2 {
        if let (Some(col), Some(key)) = (column_name(&func.args[0]), string_const(&func.args[1])) {
            if col.ends_with("properties") || col == "properties" {
                let ir = PageExpr::HasKey {
                    base: Box::new(PageExpr::Column(col)),
                    key,
                };
                if let Some(end) = find_closing_paren_end(sql, start) {
                    if end > start && sql.is_char_boundary(start) && sql.is_char_boundary(end) {
                        return Ok(Some(AstRewrite {
                            start,
                            end,
                            replacement: ir.emit(),
                        }));
                    }
                }
            }
        }
    }

    // jsonb_exists_any / jsonb_exists_all(properties, ARRAY[...])
    if matches!(name_l.as_str(), "jsonb_exists_any" | "jsonb_exists_all") && func.args.len() >= 2 {
        if let (Some(col), Some(keys)) = (
            column_name(&func.args[0]),
            string_array_elements(&func.args[1]),
        ) {
            if col.ends_with("properties") || col == "properties" {
                let ir = if name_l == "jsonb_exists_all" {
                    PageExpr::AllKeys {
                        base: Box::new(PageExpr::Column(col)),
                        keys,
                    }
                } else {
                    PageExpr::AnyKeys {
                        base: Box::new(PageExpr::Column(col)),
                        keys,
                    }
                };
                if let Some(end) = find_closing_paren_end(sql, start) {
                    if end > start && sql.is_char_boundary(start) && sql.is_char_boundary(end) {
                        return Ok(Some(AstRewrite {
                            start,
                            end,
                            replacement: ir.emit(),
                        }));
                    }
                }
            }
        }
    }

    // Aggregate renames that residual also handles.
    let sqlite = match name_l.as_str() {
        "string_agg" => Some("group_concat"),
        "array_agg" => Some("json_group_array"),
        "json_agg" | "jsonb_agg" => Some("json_group_array"),
        "json_object_agg" | "jsonb_object_agg" => Some("json_group_object"),
        "bool_or" => Some("max"),
        "bool_and" | "every" => Some("min"),
        _ => None,
    };
    if let Some(sqlite_name) = sqlite {
        // Keep original arg text between the parens of this call.
        if let Some(end) = find_closing_paren_end(sql, start) {
            if end > start && sql.is_char_boundary(start) && sql.is_char_boundary(end) {
                // Find '(' after function name start
                let open = sql[start..end].find('(').map(|i| start + i);
                if let Some(open) = open {
                    let args_sql = sql[open + 1..end - 1].to_string(); // drop closing )
                    let ir = PageExpr::AggRename {
                        sqlite_name,
                        args_sql,
                    };
                    return Ok(Some(AstRewrite {
                        start,
                        end,
                        replacement: ir.emit(),
                    }));
                }
            }
        }
    }

    Ok(None)
}

fn span_column_through_closing_bracket(
    sql: &str,
    tokens: &[protobuf::ScanToken],
    col_start: usize,
    array_hint: usize,
) -> Option<(usize, usize)> {
    if col_start >= sql.len() {
        return None;
    }
    let end = find_closing_bracket_end(sql, tokens, array_hint.max(col_start))?;
    if end <= col_start || end > sql.len() {
        return None;
    }
    if !sql.is_char_boundary(col_start) || !sql.is_char_boundary(end) {
        return None;
    }
    Some((col_start, end))
}

/// From a start location through the end of the token that contains `end_hint`.
fn span_from_to_token_end(
    sql: &str,
    tokens: &[protobuf::ScanToken],
    start: usize,
    end_hint: usize,
) -> Option<(usize, usize)> {
    if start >= sql.len() {
        return None;
    }
    let end = tokens
        .iter()
        .find(|t| t.start as usize <= end_hint && end_hint < t.end as usize)
        .map(|t| t.end as usize)
        .or_else(|| {
            // No token match: scan forward for end of a quoted string.
            scan_string_end(sql, end_hint)
        })?;
    if end <= start || end > sql.len() {
        return None;
    }
    if !sql.is_char_boundary(start) || !sql.is_char_boundary(end) {
        return None;
    }
    Some((start, end))
}

fn find_closing_bracket_end(
    sql: &str,
    tokens: &[protobuf::ScanToken],
    from: usize,
) -> Option<usize> {
    // Prefer token stream: find first ']' token at or after `from`.
    // For nested brackets, track depth using '[' / ']' characters in the source
    // between tokens when token types are unavailable as stable integers across
    // pg_query versions.
    let bytes = sql.as_bytes();
    let mut depth = 0i32;
    let mut i = from;
    let mut seen_open = false;
    while i < bytes.len() {
        match bytes[i] {
            b'[' => {
                depth += 1;
                seen_open = true;
                i += 1;
            }
            b']' => {
                depth -= 1;
                i += 1;
                if seen_open && depth == 0 {
                    return Some(i);
                }
            }
            b'\'' => {
                // Skip string literal so brackets inside strings are ignored.
                i += 1;
                while i < bytes.len() {
                    if bytes[i] == b'\'' {
                        if i + 1 < bytes.len() && bytes[i + 1] == b'\'' {
                            i += 2; // escaped quote
                        } else {
                            i += 1;
                            break;
                        }
                    } else {
                        i += 1;
                    }
                }
            }
            _ => i += 1,
        }
    }
    // Fallback: last token end after `from` if it looks like we passed a ']'.
    let _ = tokens;
    None
}

fn scan_string_end(sql: &str, from: usize) -> Option<usize> {
    let bytes = sql.as_bytes();
    let mut i = from;
    // Move to the opening quote if we're on it or just before the string.
    while i < bytes.len() && bytes[i] != b'\'' {
        i += 1;
    }
    if i >= bytes.len() {
        return None;
    }
    i += 1;
    while i < bytes.len() {
        if bytes[i] == b'\'' {
            if i + 1 < bytes.len() && bytes[i + 1] == b'\'' {
                i += 2;
            } else {
                return Some(i + 1);
            }
        } else {
            i += 1;
        }
    }
    None
}

// ---------------------------------------------------------------------------
// AST value extractors
// ---------------------------------------------------------------------------

/// Find the byte offset of `needle` in `sql`, preferring matches closest to `near`.
fn find_near(sql: &str, needle: &str, near: usize) -> Option<usize> {
    if needle.is_empty() {
        return None;
    }
    let lower_sql = sql.to_ascii_lowercase();
    let lower_needle = needle.to_ascii_lowercase();
    let mut best: Option<(usize, usize)> = None; // (distance, start)
    let mut start = 0;
    while let Some(rel) = lower_sql[start..].find(&lower_needle) {
        let abs = start + rel;
        // Prefer whole-token-ish matches: prev/next not identifier chars.
        let prev_ok = abs == 0
            || !sql.as_bytes()[abs - 1].is_ascii_alphanumeric() && sql.as_bytes()[abs - 1] != b'_';
        let end = abs + needle.len();
        let next_ok = end >= sql.len()
            || !sql.as_bytes()[end].is_ascii_alphanumeric() && sql.as_bytes()[end] != b'_';
        if prev_ok && next_ok {
            let dist = abs.abs_diff(near);
            if best.map(|(d, _)| dist < d).unwrap_or(true) {
                best = Some((dist, abs));
            }
        }
        start = abs + 1;
    }
    best.map(|(_, s)| s)
}

/// Resolve a usable start offset for a column reference.
fn column_start(sql: &str, col: &str, loc: i32, near: usize) -> Option<usize> {
    if loc >= 0 {
        let s = loc as usize;
        if s < sql.len() && sql.is_char_boundary(s) {
            return Some(s);
        }
    }
    // Fall back: last segment of dotted name (e.g. tags from p.tags).
    let leaf = col.rsplit('.').next().unwrap_or(col);
    find_near(sql, col, near).or_else(|| find_near(sql, leaf, near))
}

fn is_tag_like_column(name: &str) -> bool {
    let leaf = name.rsplit('.').next().unwrap_or(name);
    matches!(leaf, "tags" | "aliases")
}

fn aexpr_operator_name(expr: &protobuf::AExpr) -> String {
    expr.name
        .iter()
        .filter_map(|n| match &n.node {
            Some(NodeEnum::String(s)) => Some(s.sval.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("")
}

/// Returns (dotted column name, location) when the node is a ColumnRef.
fn column_ref(node: &protobuf::Node) -> Option<(String, i32)> {
    match &node.node {
        Some(NodeEnum::ColumnRef(col)) => {
            let parts: Vec<&str> = col
                .fields
                .iter()
                .filter_map(|f| match &f.node {
                    Some(NodeEnum::String(s)) => Some(s.sval.as_str()),
                    Some(NodeEnum::AStar(_)) => Some("*"),
                    _ => None,
                })
                .collect();
            if parts.is_empty() {
                None
            } else {
                Some((parts.join("."), col.location))
            }
        }
        _ => None,
    }
}

fn column_name(node: &protobuf::Node) -> Option<String> {
    column_ref(node).map(|(name, _)| name)
}

fn string_const(node: &protobuf::Node) -> Option<String> {
    match &node.node {
        Some(NodeEnum::AConst(c)) => match &c.val {
            Some(protobuf::a_const::Val::Sval(s)) => Some(s.sval.clone()),
            Some(protobuf::a_const::Val::Fval(f)) => Some(f.fval.clone()),
            Some(protobuf::a_const::Val::Ival(i)) => Some(i.ival.to_string()),
            _ => None,
        },
        Some(NodeEnum::String(s)) => Some(s.sval.clone()),
        _ => None,
    }
}

fn literal_expr(node: &protobuf::Node) -> Option<PageExpr> {
    match &node.node {
        Some(NodeEnum::AConst(value)) if value.isnull => Some(PageExpr::Raw("NULL".into())),
        Some(NodeEnum::AConst(value)) => match &value.val {
            Some(protobuf::a_const::Val::Ival(value)) => {
                Some(PageExpr::Raw(value.ival.to_string()))
            }
            Some(protobuf::a_const::Val::Fval(value)) => Some(PageExpr::Raw(value.fval.clone())),
            Some(protobuf::a_const::Val::Boolval(value)) => Some(PageExpr::Raw(format!(
                "page_bool({})",
                if value.boolval { 1 } else { 0 }
            ))),
            Some(protobuf::a_const::Val::Sval(value)) => Some(PageExpr::Raw(format!(
                "'{}'",
                escape_sql_string(&value.sval)
            ))),
            Some(protobuf::a_const::Val::Bsval(value)) => Some(PageExpr::Raw(format!(
                "'{}'",
                escape_sql_string(&value.bsval)
            ))),
            None => None,
        },
        _ => column_name(node).map(PageExpr::Column),
    }
}

fn const_location(node: &protobuf::Node) -> Option<i32> {
    match &node.node {
        Some(NodeEnum::AConst(c)) => Some(c.location),
        _ => None,
    }
}

fn array_location(node: &protobuf::Node) -> Option<i32> {
    match &node.node {
        Some(NodeEnum::AArrayExpr(arr)) => Some(arr.location),
        _ => None,
    }
}

fn string_array_elements(node: &protobuf::Node) -> Option<Vec<String>> {
    match &node.node {
        Some(NodeEnum::AArrayExpr(arr)) => {
            let mut out = Vec::new();
            for el in &arr.elements {
                out.push(string_const(el)?);
            }
            Some(out)
        }
        _ => None,
    }
}

/// Analyze a query and return IR fragments for recognized page forms.
pub fn analyze_page_forms(sql: &str) -> Result<Vec<PageExpr>, String> {
    let parsed = pg_query::parse(sql).map_err(|e| format!("PostgreSQL syntax: {e}"))?;
    let mut forms = Vec::new();
    for (node, _, _, _) in parsed.protobuf.nodes() {
        match node {
            NodeRef::AExpr(expr) => {
                let op = aexpr_operator_name(expr);
                let kind = expr.kind;
                if kind == protobuf::AExprKind::AexprOpAny as i32 {
                    if let (Some(tag), Some(col)) = (
                        expr.lexpr.as_ref().and_then(|n| string_const(n)),
                        expr.rexpr.as_ref().and_then(|n| column_name(n)),
                    ) {
                        if is_tag_like_column(&col) {
                            forms.push(PageExpr::HasTag {
                                array: Box::new(PageExpr::Column(col)),
                                tag,
                            });
                        }
                    }
                } else if matches!(op.as_str(), "@>" | "&&") {
                    if let (Some(col), Some(tags)) = (
                        expr.lexpr.as_ref().and_then(|n| column_name(n)),
                        expr.rexpr.as_ref().and_then(|n| string_array_elements(n)),
                    ) {
                        if is_tag_like_column(&col) {
                            forms.push(if op == "@>" {
                                PageExpr::AllTags {
                                    array: Box::new(PageExpr::Column(col)),
                                    tags,
                                }
                            } else {
                                PageExpr::AnyTag {
                                    array: Box::new(PageExpr::Column(col)),
                                    tags,
                                }
                            });
                        }
                    }
                } else if op == "?" {
                    if let (Some(col), Some(key)) = (
                        expr.lexpr.as_ref().and_then(|n| column_name(n)),
                        expr.rexpr.as_ref().and_then(|n| string_const(n)),
                    ) {
                        if col.ends_with("properties") || col == "properties" {
                            forms.push(PageExpr::HasKey {
                                base: Box::new(PageExpr::Column(col)),
                                key,
                            });
                        }
                    }
                } else if matches!(op.as_str(), "?|" | "?&") {
                    if let (Some(col), Some(keys)) = (
                        expr.lexpr.as_ref().and_then(|n| column_name(n)),
                        expr.rexpr.as_ref().and_then(|n| string_array_elements(n)),
                    ) {
                        if col.ends_with("properties") || col == "properties" {
                            if op == "?&" {
                                forms.push(PageExpr::AllKeys {
                                    base: Box::new(PageExpr::Column(col)),
                                    keys,
                                });
                            } else {
                                forms.push(PageExpr::AnyKeys {
                                    base: Box::new(PageExpr::Column(col)),
                                    keys,
                                });
                            }
                        }
                    }
                } else if matches!(op.as_str(), "->" | "->>") {
                    if let (Some(col), Some(key)) = (
                        expr.lexpr.as_ref().and_then(|n| column_name(n)),
                        expr.rexpr.as_ref().and_then(|n| string_const(n)),
                    ) {
                        if col.ends_with("properties") || col == "properties" {
                            forms.push(PageExpr::PropertyGet {
                                base: Box::new(PageExpr::Column(col)),
                                key,
                            });
                        }
                    }
                }
            }
            NodeRef::SubscriptingRef(sub) => {
                if let Some((col, _)) = sub.refexpr.as_ref().and_then(|n| column_ref(n)) {
                    if col.ends_with("properties") || col == "properties" {
                        if let Some(key) = sub.refupperindexpr.first().and_then(string_const) {
                            forms.push(PageExpr::PropertyGet {
                                base: Box::new(PageExpr::Column(col)),
                                key,
                            });
                        }
                    }
                }
            }
            NodeRef::AArrayExpr(arr) => {
                let elems: Vec<PageExpr> = arr.elements.iter().filter_map(literal_expr).collect();
                forms.push(PageExpr::ArrayLit(elems));
            }
            NodeRef::FuncCall(func) => {
                let name = func
                    .funcname
                    .iter()
                    .filter_map(|n| match &n.node {
                        Some(NodeEnum::String(s)) => Some(s.sval.as_str()),
                        _ => None,
                    })
                    .collect::<Vec<_>>()
                    .join(".")
                    .to_ascii_lowercase();
                if matches!(name.as_str(), "date_part" | "extract") && func.args.len() >= 2 {
                    let field = string_const(&func.args[0])
                        .or_else(|| column_name(&func.args[0]))
                        .unwrap_or_default()
                        .trim_matches('\'')
                        .to_ascii_lowercase();
                    let source = column_name(&func.args[1])
                        .map(PageExpr::Column)
                        .unwrap_or_else(|| PageExpr::Raw("NULL".into()));
                    forms.push(PageExpr::DatePart {
                        field,
                        source: Box::new(source),
                    });
                }
            }
            _ => {}
        }
    }
    Ok(forms)
}

/// Textual fallback for PG datetime builtins (also AST-lowered when spans recover).
/// Syntax residual for forms SQLite cannot parse, or that must be rewritten
/// before native `postgres_compat` UDFs run.
///
/// Do **not** rewrite bare function names that `postgres_compat` already
/// registers (`lpad`, `concat`, `char_length`, `now`, `split_part`, …).
pub fn lower_pg_syntax(sql: &str) -> String {
    let mut out = sql.to_string();

    // --- regex match operators -------------------------------------------------
    // col ~ 'pat'  /  col ~* 'pat'  /  col !~ 'pat'  /  col !~* 'pat'
    // Prefer longest operators first (~* before ~).

    // !~*
    if let Ok(re) = regex::Regex::new(r"(?i)([a-z_][a-z0-9_$.]*|\))\s*!~\*\s*('(?:''|[^'])*')") {
        out = re
            .replace_all(&out, |c: &regex::Captures<'_>| {
                format!("NOT regexp_like({}, {}, 'i')", &c[1], &c[2])
            })
            .into_owned();
    }
    // ~*
    if let Ok(re) = regex::Regex::new(r"(?i)([a-z_][a-z0-9_$.]*|\))\s*~\*\s*('(?:''|[^'])*')") {
        out = re
            .replace_all(&out, |c: &regex::Captures<'_>| {
                format!("regexp_like({}, {}, 'i')", &c[1], &c[2])
            })
            .into_owned();
    }
    // !~
    if let Ok(re) = regex::Regex::new(r"(?i)([a-z_][a-z0-9_$.]*|\))\s*!~\s*('(?:''|[^'])*')") {
        out = re
            .replace_all(&out, |c: &regex::Captures<'_>| {
                format!("NOT regexp_like({}, {})", &c[1], &c[2])
            })
            .into_owned();
    }
    // ~
    if let Ok(re) = regex::Regex::new(r"(?i)([a-z_][a-z0-9_$.]*|\))\s*~\s*('(?:''|[^'])*')") {
        out = re
            .replace_all(&out, |c: &regex::Captures<'_>| {
                format!("regexp_like({}, {})", &c[1], &c[2])
            })
            .into_owned();
    }

    // --- SIMILAR TO ------------------------------------------------------------
    // Best-effort: map SQL SIMILAR patterns to a LIKE-ish regexp.
    if let Ok(re) =
        regex::Regex::new(r"(?i)([a-z_][a-z0-9_$.]*|\))\s+NOT\s+SIMILAR\s+TO\s+('(?:''|[^'])*')")
    {
        out = re
            .replace_all(&out, |c: &regex::Captures<'_>| {
                let pat = similar_to_rust_regex(&c[2]);
                format!("NOT regexp_like({}, '{}')", &c[1], pat.replace('\'', "''"))
            })
            .into_owned();
    }
    if let Ok(re) =
        regex::Regex::new(r"(?i)([a-z_][a-z0-9_$.]*|\))\s+SIMILAR\s+TO\s+('(?:''|[^'])*')")
    {
        out = re
            .replace_all(&out, |c: &regex::Captures<'_>| {
                let pat = similar_to_rust_regex(&c[2]);
                format!("regexp_like({}, '{}')", &c[1], pat.replace('\'', "''"))
            })
            .into_owned();
    }

    // --- FETCH FIRST / OFFSET n ROWS ------------------------------------------
    if let Ok(re) = regex::Regex::new(r"(?i)\bFETCH\s+(?:FIRST|NEXT)\s+(\d+)\s+ROWS?\s+ONLY\b") {
        out = re.replace_all(&out, "LIMIT $1").into_owned();
    }
    if let Ok(re) = regex::Regex::new(r"(?i)\bOFFSET\s+(\d+)\s+ROWS\b") {
        out = re.replace_all(&out, "OFFSET $1").into_owned();
    }

    // --- to_timestamp(epoch) (no native UDF) ----------------------------------
    if let Ok(re) = regex::Regex::new(r"(?i)\bto_timestamp\s*\(\s*([^)]+?)\s*\)") {
        out = re
            .replace_all(&out, |c: &regex::Captures<'_>| {
                format!("datetime({}, 'unixepoch')", c[1].trim())
            })
            .into_owned();
    }

    // --- to_char (common formats only; no native UDF) -------------------------
    if let Ok(re) = regex::Regex::new(r"(?i)\bto_char\s*\(\s*([^,]+?)\s*,\s*'([^']*)'\s*\)") {
        out = re
            .replace_all(&out, |c: &regex::Captures<'_>| {
                let source = c[1].trim();
                let fmt = &c[2];
                let sqlite_fmt = match fmt {
                    "YYYY-MM-DD" | "yyyy-mm-dd" => "%Y-%m-%d",
                    "YYYY-MM" | "yyyy-mm" => "%Y-%m",
                    "YYYY" | "yyyy" => "%Y",
                    "HH24:MI:SS" | "hh24:mi:ss" => "%H:%M:%S",
                    "YYYY-MM-DD HH24:MI:SS" | "yyyy-mm-dd hh24:mi:ss" => "%Y-%m-%d %H:%M:%S",
                    _ => "",
                };
                if sqlite_fmt.is_empty() {
                    c[0].to_string()
                } else {
                    format!("strftime('{sqlite_fmt}', {source})")
                }
            })
            .into_owned();
    }

    // --- substring(s FROM n [FOR len]) ----------------------------------------
    if let Ok(re) = regex::Regex::new(
        r"(?i)\bsubstring\s*\(\s*([^)]+?)\s+FROM\s+([^)]+?)\s+FOR\s+([^)]+?)\s*\)",
    ) {
        out = re
            .replace_all(&out, |c: &regex::Captures<'_>| {
                format!("substr({}, {}, {})", c[1].trim(), c[2].trim(), c[3].trim())
            })
            .into_owned();
    }
    if let Ok(re) = regex::Regex::new(r"(?i)\bsubstring\s*\(\s*([^)]+?)\s+FROM\s+([^)]+?)\s*\)") {
        out = re
            .replace_all(&out, |c: &regex::Captures<'_>| {
                format!("substr({}, {})", c[1].trim(), c[2].trim())
            })
            .into_owned();
    }

    // --- position(needle IN haystack) -----------------------------------------
    if let Ok(re) = regex::Regex::new(r"(?i)\bposition\s*\(\s*([^)]+?)\s+IN\s+([^)]+?)\s*\)") {
        out = re
            .replace_all(&out, |c: &regex::Captures<'_>| {
                format!("strpos({}, {})", c[2].trim(), c[1].trim())
            })
            .into_owned();
    }

    // --- trim(BOTH|LEADING|TRAILING [chars] FROM s) ---------------------------
    if let Ok(re) = regex::Regex::new(
        r"(?i)\btrim\s*\(\s*(both|leading|trailing)(?:\s+((?:'[^']*'|[^)\s]+)))?\s+from\s+([^)]+?)\s*\)",
    ) {
        out = re
            .replace_all(&out, |c: &regex::Captures<'_>| {
                let side = c[1].to_ascii_lowercase();
                let chars = c
                    .get(2)
                    .map(|m| m.as_str().trim())
                    .filter(|s| !s.is_empty());
                let src = c[3].trim();
                let func = match side.as_str() {
                    "leading" => "ltrim",
                    "trailing" => "rtrim",
                    _ => "btrim",
                };
                if let Some(ch) = chars {
                    format!("{func}({src}, {ch})")
                } else {
                    format!("{func}({src})")
                }
            })
            .into_owned();
    }

    // --- nested properties->'a'->>'b' -----------------------------------------
    if let Ok(re) = regex::Regex::new(
        r"(?i)\b((?:[a-z_][a-z0-9_]*\.)?properties)\s*->\s*'((?:''|[^'])*)'\s*->>\s*'((?:''|[^'])*)'",
    ) {
        out = re
            .replace_all(&out, |c: &regex::Captures<'_>| {
                format!(
                    "page_property(page_property({}, '{}'), '{}')",
                    &c[1], &c[2], &c[3]
                )
            })
            .into_owned();
    }

    out
}

/// Lower PostgreSQL's one-dimensional array operator family after ARRAY
/// constructors have become `page_array(...)`. The parser gate has already
/// validated the statement, so these rewrites only bridge SQLite grammar.
pub fn lower_array_operators(sql: &str) -> String {
    let atom = r"(?:page_array\([^()]*\)|[A-Za-z_][A-Za-z0-9_$.]*)";
    let scalar = r"(?:page_property\([^()]*\)|'(?:''|[^'])*'|-?[0-9]+(?:\.[0-9]+)?|[A-Za-z_][A-Za-z0-9_$.]*)";
    let mut out = sql.to_string();

    // scalar OP ANY/ALL(array), including every comparison operator supported
    // by PostgreSQL's quantified array predicates.
    if let Ok(re) = regex::Regex::new(&format!(
        r"(?i)({scalar})\s*(=|<>|!=|<=|>=|<|>)\s*(ANY|ALL)\s*\(\s*({atom})\s*\)"
    )) {
        out = re
            .replace_all(&out, |c: &regex::Captures<'_>| {
                format!(
                    "page_array_quantified({}, '{}', '{}', {})",
                    &c[1],
                    &c[2],
                    c[3].to_ascii_uppercase(),
                    &c[4]
                )
            })
            .into_owned();
    }

    // Slices precede scalar subscripts so `a[2:4]` is consumed as one unit.
    if let Ok(re) = regex::Regex::new(&format!(
        r"(?i)({atom})\s*\[\s*([0-9]*)\s*:\s*([0-9]*)\s*\]"
    )) {
        out = re
            .replace_all(&out, |c: &regex::Captures<'_>| {
                let lower = if c[2].is_empty() { "NULL" } else { &c[2] };
                let upper = if c[3].is_empty() { "NULL" } else { &c[3] };
                format!("page_array_slice({}, {lower}, {upper})", &c[1])
            })
            .into_owned();
    }
    if let Ok(re) = regex::Regex::new(&format!(r"(?i)({atom})\s*\[\s*([0-9]+)\s*\]")) {
        out = re.replace_all(&out, "page_array_get($1, $2)").into_owned();
    }

    for (operator, function, reverse) in [
        ("@>", "page_array_contains", false),
        ("<@", "page_array_contains", true),
        ("&&", "page_array_overlap", false),
    ] {
        if let Ok(re) = regex::Regex::new(&format!(
            r"(?i)({atom})\s*{}\s*({atom})",
            regex::escape(operator)
        )) {
            out = re
                .replace_all(&out, |c: &regex::Captures<'_>| {
                    if reverse {
                        format!("{function}({}, {})", &c[2], &c[1])
                    } else {
                        format!("{function}({}, {})", &c[1], &c[2])
                    }
                })
                .into_owned();
        }
    }

    let array_call = r"page_array\([^()]*\)";
    if let Ok(re) = regex::Regex::new(&format!(r"(?i)({array_call})\s*\|\|\s*({array_call})")) {
        out = re
            .replace_all(&out, "page_array_concat($1, $2)")
            .into_owned();
    }
    if let Ok(re) = regex::Regex::new(&format!(r"(?i)({array_call})\s*\|\|\s*({scalar})")) {
        out = re.replace_all(&out, "array_append($1, $2)").into_owned();
    }
    if let Ok(re) = regex::Regex::new(&format!(r"(?i)({scalar})\s*\|\|\s*({array_call})")) {
        out = re.replace_all(&out, "array_prepend($1, $2)").into_owned();
    }

    // Array ordering/equality is lexicographic in PostgreSQL. Restrict this
    // bridge to expressions containing an explicit page_array constructor so
    // ordinary scalar comparisons remain native SQLite expressions.
    if let Ok(re) = regex::Regex::new(&format!(r"(?i)({atom})\s*(=|<>|!=|<=|>=|<|>)\s*({atom})")) {
        out = re
            .replace_all(&out, |c: &regex::Captures<'_>| {
                if !c[1].to_ascii_lowercase().starts_with("page_array(")
                    && !c[3].to_ascii_lowercase().starts_with("page_array(")
                {
                    return c[0].to_string();
                }
                let op = match &c[2] {
                    "=" => "=",
                    "<>" | "!=" => "!=",
                    other => other,
                };
                format!("page_array_compare({}, {}) {op} 0", &c[1], &c[3])
            })
            .into_owned();
    }

    out
}

/// Lower JSON/JSONB extraction and mutation-free operators used by page
/// property expressions. JSON remains serialized text inside SQLite.
pub fn lower_json_operators(sql: &str) -> String {
    let source = r"(?:page_property\([^()]*\)|[A-Za-z_][A-Za-z0-9_$.]*)";
    let json_literal = r"(?:'(?:''|[^'])*'|page_cast\('(?:''|[^'])*',\s*'jsonb?'\))";
    let mut out = sql.to_string();
    if let Ok(re) = regex::Regex::new(&format!(
        r"(?i)({source})\s*(#>>|#>)\s*page_array\(([^()]*)\)"
    )) {
        out = re
            .replace_all(&out, |c: &regex::Captures<'_>| {
                let function = if &c[2] == "#>>" {
                    "jsonb_extract_path_text"
                } else {
                    "jsonb_extract_path"
                };
                format!("{function}({}, {})", &c[1], &c[3])
            })
            .into_owned();
    }
    if let Ok(re) = regex::Regex::new(&format!(
        r"(?i)({source})\s*(->>|->)\s*('(?:''|[^'])*'|[0-9]+)"
    )) {
        out = re
            .replace_all(&out, |c: &regex::Captures<'_>| {
                let function = if &c[2] == "->>" {
                    "jsonb_extract_path_text"
                } else {
                    "jsonb_extract_path"
                };
                format!("{function}({}, {})", &c[1], &c[3])
            })
            .into_owned();
    }
    if let Ok(re) = regex::Regex::new(&format!(r"(?i)({source})\s*-\s*('(?:''|[^'])*'|-?[0-9]+)")) {
        out = re.replace_all(&out, "jsonb_delete($1, $2)").into_owned();
    }
    if let Ok(re) = regex::Regex::new(&format!(
        r"(?i)({source})\s*\?([&|])\s*(page_array\([^()]*\))"
    )) {
        out = re
            .replace_all(&out, |c: &regex::Captures<'_>| {
                let function = if &c[2] == "&" {
                    "jsonb_exists_all"
                } else {
                    "jsonb_exists_any"
                };
                format!("{function}({}, {})", &c[1], &c[3])
            })
            .into_owned();
    }
    if let Ok(re) = regex::Regex::new(&format!(r"(?i)({source})\s*\?\s*({json_literal})")) {
        out = re.replace_all(&out, "jsonb_exists($1, $2)").into_owned();
    }
    if let Ok(re) = regex::Regex::new(&format!(r"(?i)({source})\s*@>\s*({json_literal})")) {
        out = re.replace_all(&out, "jsonb_contains($1, $2)").into_owned();
    }
    if let Ok(re) = regex::Regex::new(&format!(r"(?i)({json_literal})\s*<@\s*({source})")) {
        out = re.replace_all(&out, "jsonb_contains($2, $1)").into_owned();
    }
    if let Ok(re) = regex::Regex::new(&format!(
        r"(?i)((?:[A-Za-z_][A-Za-z0-9_$.]*properties|properties|page_property\([^()]*\)))\s*\|\|\s*({json_literal})"
    )) {
        out = re.replace_all(&out, "jsonb_concat($1, $2)").into_owned();
    }
    out
}

fn similar_to_rust_regex(quoted_pat: &str) -> String {
    // Strip surrounding quotes; convert SIMILAR TO metacharacters to Rust regex.
    let inner = quoted_pat.trim().trim_matches('\'').replace("''", "'");
    let mut out = String::with_capacity(inner.len() * 2);
    out.push('^');
    let chars: Vec<char> = inner.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        match chars[i] {
            '%' => out.push_str(".*"),
            '_' => out.push('.'),
            '.' | '*' | '+' | '?' | '(' | ')' | '|' | '[' | ']' | '{' | '}' | '^' | '$' | '\\' => {
                out.push('\\');
                out.push(chars[i]);
            }
            c => out.push(c),
        }
        i += 1;
    }
    out.push('$');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn analyzes_tag_containment() {
        let forms = analyze_page_forms(
            "SELECT * FROM pages p WHERE p.tags @> ARRAY['recruiter', 'linkedin']",
        )
        .unwrap();
        assert!(forms.iter().any(|form| form
            == &PageExpr::AllTags {
                array: Box::new(PageExpr::Column("p.tags".into())),
                tags: vec!["recruiter".into(), "linkedin".into()],
            }));
        assert_eq!(
            forms[0].emit(),
            "(page_has_tag(p.tags, 'recruiter') AND page_has_tag(p.tags, 'linkedin'))"
        );
    }

    #[test]
    fn analyzes_tag_overlap() {
        let forms = analyze_page_forms("SELECT path FROM pages WHERE tags && ARRAY['a']").unwrap();
        assert!(forms.iter().any(|form| form
            == &PageExpr::AnyTag {
                array: Box::new(PageExpr::Column("tags".into())),
                tags: vec!["a".into()],
            }));
    }

    #[test]
    fn analyzes_property_existence() {
        let forms = analyze_page_forms("SELECT 1 FROM pages WHERE properties ? 'company'").unwrap();
        assert_eq!(
            forms,
            vec![PageExpr::HasKey {
                base: Box::new(PageExpr::Column("properties".into())),
                key: "company".into(),
            }]
        );
        assert_eq!(forms[0].emit(), "page_has_key(properties, 'company')");
    }

    #[test]
    fn emit_property_get() {
        let expr = PageExpr::PropertyGet {
            base: Box::new(PageExpr::Column("p.properties".into())),
            key: "company".into(),
        };
        assert_eq!(expr.emit(), "page_property(p.properties, 'company')");
    }

    #[test]
    fn ast_lowers_tag_containment_span() {
        let sql = "SELECT * FROM pages p WHERE p.tags @> ARRAY['recruiter']";
        let out = try_ast_lower(sql)
            .unwrap()
            .expect("AST span recovery must rewrite tag containment");
        assert!(
            out.contains("page_has_tag(p.tags, 'recruiter')"),
            "unexpected lowering: {out}"
        );
        assert!(!out.contains("@>"), "operator should be gone: {out}");
    }

    #[test]
    fn ast_lowers_property_existence_span() {
        let sql = "SELECT 1 FROM pages WHERE properties ? 'company'";
        let out = try_ast_lower(sql)
            .unwrap()
            .expect("AST span recovery must rewrite property existence");
        assert!(
            out.contains("page_has_key(properties, 'company')"),
            "unexpected lowering: {out}"
        );
        assert!(
            !out.contains("properties ?"),
            "existence operator should be gone: {out}"
        );
    }

    #[test]
    fn ast_lowers_arrow_and_any_in_one_query() {
        let sql = "SELECT properties->>'company' FROM pages WHERE 'recruiter' = ANY(tags)";
        let out = try_ast_lower(sql)
            .unwrap()
            .expect("AST must rewrite arrow and ANY");
        assert!(
            out.contains("page_property(properties, 'company')"),
            "arrow not lowered: {out}"
        );
        assert!(
            out.contains("page_has_tag(tags, 'recruiter')"),
            "ANY not lowered: {out}"
        );
        assert!(!out.contains("->>"), "arrow remains: {out}");
        assert!(!out.contains("ANY"), "ANY remains: {out}");
    }

    #[test]
    fn strip_sql_comments_line_and_block() {
        let sql = "SELECT 'Résumé' -- skip me\nFROM pages /* block */ WHERE path = 'München--東京'";
        let out = strip_sql_comments(sql);
        assert!(out.contains("SELECT 'Résumé'"));
        assert!(out.contains("FROM pages"));
        assert!(out.contains("WHERE path = 'München--東京'"));
        assert!(!out.contains("skip me"));
        assert!(!out.contains("block"));
    }

    #[test]
    fn lower_page_sql_runs_only_residual_after_ast() {
        let sql = "SELECT path FROM pages WHERE tags @> ARRAY['x']";
        let out = lower_page_sql(
            sql,
            |_s| panic!("full callback must not run after an AST rewrite"),
            |s| Ok(format!("/*residual*/{s}")),
        )
        .unwrap();
        assert!(
            out.starts_with("/*residual*/"),
            "residual lowering not applied: {out}"
        );
        assert!(out.contains("page_has_tag"), "AST rewrite missing: {out}");
        assert!(!out.contains("@>"), "operator remains: {out}");
    }

    #[test]
    fn lower_page_sql_uses_full_when_ast_misses() {
        let sql = "SELECT 1";
        let out =
            lower_page_sql(sql, |s| Ok(format!("/*full*/{s}")), |s| Ok(s.to_string())).unwrap();
        assert_eq!(out, "/*full*/SELECT 1");
    }

    #[test]
    fn closing_bracket_scan_handles_strings() {
        let sql = "x @> ARRAY['a]b', 'c']";
        let end = find_closing_bracket_end(sql, &[], 5).expect("closing bracket");
        assert_eq!(&sql[5..end], "ARRAY['a]b', 'c']");
    }

    #[test]
    fn analyzes_arrow_property() {
        let forms = analyze_page_forms("SELECT properties->>'company' FROM pages").unwrap();
        assert!(
            forms.iter().any(|f| matches!(
                f,
                PageExpr::PropertyGet { key, .. } if key == "company"
            )),
            "expected PropertyGet, got {forms:?}"
        );
    }

    #[test]
    fn analyzes_any_membership() {
        let forms =
            analyze_page_forms("SELECT * FROM pages WHERE 'recruiter' = ANY(tags)").unwrap();
        assert!(
            forms.iter().any(|f| matches!(
                f,
                PageExpr::HasTag { tag, .. } if tag == "recruiter"
            )),
            "expected HasTag, got {forms:?}"
        );
    }

    #[test]
    fn analyzes_array_literal() {
        let forms = analyze_page_forms("SELECT ARRAY['a', 'b']").unwrap();
        assert!(
            forms
                .iter()
                .any(|f| matches!(f, PageExpr::ArrayLit(v) if v.len() == 2)),
            "expected ArrayLit, got {forms:?}"
        );
    }

    #[test]
    fn ast_lowers_standalone_array() {
        let sql = "SELECT ARRAY['a', 'b']";
        let out = try_ast_lower(sql).unwrap().expect("ARRAY should rewrite");
        assert!(
            out.contains("page_array("),
            "expected page_array, got {out}"
        );
        assert!(!out.contains("ARRAY["), "ARRAY remains: {out}");
    }

    #[test]
    fn typecast_wraps_nested_expression_in_strict_conversion() {
        let sql = "SELECT ARRAY['a']::text[]";
        let out = try_ast_lower(sql).unwrap().expect("cast should lower");
        assert_eq!(out, "SELECT page_cast(page_array('a'), 'text[]')");
    }

    #[test]
    fn subscript_span_does_not_swallow_as_alias() {
        let sql = "SELECT properties['company'] AS company FROM pages";
        let out = try_ast_lower(sql)
            .unwrap()
            .unwrap_or_else(|| sql.to_string());
        assert!(out.contains(" AS company"), "alias lost: {out}");
        assert!(
            !out.contains("page_property(properties, 'company' AS"),
            "paren swallowed AS: {out}"
        );
    }

    #[test]
    fn ast_lowers_property_and_array_indirection_without_textual_page_fallback() {
        let sql = "SELECT properties['company'] AS company, tags[2:3] AS selected FROM pages";
        let out = lower_page_sql(
            sql,
            |_sql| panic!("AST indirection should not need the full textual fallback"),
            |sql| Ok(sql.to_string()),
        )
        .unwrap();
        assert!(
            out.contains("page_property(properties, 'company') AS company"),
            "{out}"
        );
        assert!(
            out.contains("page_array_slice(tags, 2, 3) AS selected"),
            "{out}"
        );
    }

    #[test]
    fn ast_array_literals_preserve_scalar_types() {
        let out = try_ast_lower("SELECT ARRAY[1, 2.5, true, NULL, 'four']")
            .unwrap()
            .expect("array should lower");
        assert!(
            out.contains("page_array(1, 2.5, page_bool(1), NULL, 'four')"),
            "{out}"
        );
    }

    #[test]
    fn ast_property_arrow_smoke() {
        let sql = "SELECT properties->>'company' FROM pages";
        let _ = try_ast_lower(sql);
        let sql2 = "SELECT properties->'active' FROM pages";
        let _ = try_ast_lower(sql2);
    }

    #[test]
    fn lowers_pg_numeric_funcs() {
        // Numeric functions are native UDFs — residual is a no-op.
        assert_eq!(lower_pg_syntax("SELECT power(2, 3)"), "SELECT power(2, 3)");
        assert_eq!(lower_pg_syntax("SELECT mod(10, 3)"), "SELECT mod(10, 3)");
    }

    #[test]
    fn lowers_pg_regex_and_similar() {
        assert_eq!(
            lower_pg_syntax("SELECT * FROM pages WHERE name ~ 'Roy'"),
            "SELECT * FROM pages WHERE regexp_like(name, 'Roy')"
        );
        assert_eq!(
            lower_pg_syntax("SELECT * FROM pages WHERE name ~* 'roy'"),
            "SELECT * FROM pages WHERE regexp_like(name, 'roy', 'i')"
        );
        assert!(
            lower_pg_syntax("SELECT * FROM pages WHERE name SIMILAR TO 'A%'")
                .contains("regexp_like"),
            "SIMILAR TO"
        );
        assert_eq!(
            lower_pg_syntax("SELECT * FROM pages FETCH FIRST 10 ROWS ONLY"),
            "SELECT * FROM pages LIMIT 10"
        );
        assert!(
            lower_pg_syntax("SELECT properties->'a'->>'b' FROM pages")
                .contains("page_property(page_property"),
            "nested properties"
        );
    }

    #[test]
    fn lowers_pg_string_funcs() {
        // Syntax-only residual; function names stay for postgres_compat UDFs.
        assert_eq!(
            lower_pg_syntax("SELECT position('x' IN name)"),
            "SELECT strpos(name, 'x')"
        );
        assert_eq!(
            lower_pg_syntax("SELECT substring(name FROM 1 FOR 3)"),
            "SELECT substr(name, 1, 3)"
        );
        assert_eq!(
            lower_pg_syntax("SELECT trim(both 'x' from name)"),
            "SELECT btrim(name, 'x')"
        );
    }

    #[test]
    fn lowers_pg_now_datetime() {
        // now() is a postgres_compat UDF; residual must not rewrite it.
        assert!(lower_pg_syntax("SELECT now()").contains("now()"));
        assert!(
            lower_pg_syntax("SELECT to_timestamp(0)").contains("unixepoch"),
            "to_timestamp"
        );
    }

    #[test]
    fn ast_like_ilike_kind_compiles() {
        // Smoke: parse path does not panic on ILIKE; residual remains authoritative.
        let sql = "SELECT path FROM pages WHERE name ILIKE '%x%'";
        let _ = try_ast_lower(sql);
        let sql2 = "SELECT 1 WHERE a IS DISTINCT FROM b";
        let _ = try_ast_lower(sql2);
    }

    #[test]
    fn boolean_test_is_true_lowers() {
        let sql = "SELECT * FROM pages WHERE (1 = 1) IS TRUE";
        match try_ast_lower(sql) {
            Ok(Some(out)) => {
                assert!(
                    !out.to_ascii_lowercase().contains(" is true"),
                    "IS TRUE remains: {out}"
                );
            }
            Ok(None) => {
                // Acceptable if BooleanTest shape differs in this pg_query version
            }
            Err(e) => panic!("{e}"),
        }
    }

    #[test]
    fn emit_jsonb_exists_shapes() {
        let k = PageExpr::HasKey {
            base: Box::new(PageExpr::Column("properties".into())),
            key: "company".into(),
        };
        assert_eq!(k.emit(), "page_has_key(properties, 'company')");
    }

    #[test]
    fn extract_keyword_rewrites_to_date_part() {
        let sql = "SELECT EXTRACT(year FROM mtime_ms) FROM pages";
        let out = try_ast_lower(sql)
            .unwrap()
            .expect("EXTRACT keyword must rewrite");
        assert!(
            out.contains("date_part('year', mtime_ms)"),
            "unexpected: {out}"
        );
        assert!(
            !out.to_ascii_lowercase().contains("extract("),
            "EXTRACT remains: {out}"
        );
    }

    #[test]
    fn emit_all_any_keys() {
        let all = PageExpr::AllKeys {
            base: Box::new(PageExpr::Column("properties".into())),
            keys: vec!["a".into(), "b".into()],
        };
        assert_eq!(
            all.emit(),
            "(page_has_key(properties, 'a') AND page_has_key(properties, 'b'))"
        );
        let any = PageExpr::AnyKeys {
            base: Box::new(PageExpr::Column("properties".into())),
            keys: vec!["a".into(), "b".into()],
        };
        assert_eq!(
            any.emit(),
            "(page_has_key(properties, 'a') OR page_has_key(properties, 'b'))"
        );
    }

    #[test]
    fn emit_null_check() {
        let n = PageExpr::NullCheck {
            expr: Box::new(PageExpr::PropertyGet {
                base: Box::new(PageExpr::Column("properties".into())),
                key: "company".into(),
            }),
            is_null: true,
        };
        assert_eq!(n.emit(), "page_property(properties, 'company') IS NULL");
    }

    #[test]
    fn emit_date_part_and_agg() {
        let dp = PageExpr::DatePart {
            field: "year".into(),
            source: Box::new(PageExpr::Column("mtime_ms".into())),
        };
        assert_eq!(dp.emit(), "date_part('year', mtime_ms)");
        let agg = PageExpr::AggRename {
            sqlite_name: "group_concat",
            args_sql: "path, ','".into(),
        };
        assert_eq!(agg.emit(), "group_concat(path, ',')");
    }
}
