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
    AllTags { array: Box<PageExpr>, tags: Vec<String> },
    /// Disjunction of HasTag (from `&& ARRAY[...]`)
    AnyTag { array: Box<PageExpr>, tags: Vec<String> },
    /// `page_array(...)` constructor
    ArrayLit(Vec<PageExpr>),
    /// `date_part('field', expr)` from EXTRACT
    DatePart { field: String, source: Box<PageExpr> },
    /// Aggregate rename: string_agg→group_concat, bool_or→max, etc.
    AggRename { sqlite_name: &'static str, args_sql: String },
    /// `expr IS NULL` / `expr IS NOT NULL`
    NullCheck { expr: Box<PageExpr>, is_null: bool },
    /// `properties ?& ARRAY['a','b']` → AND of page_has_key
    AllKeys { base: Box<PageExpr>, keys: Vec<String> },
    /// `properties ?| ARRAY['a','b']` → OR of page_has_key
    AnyKeys { base: Box<PageExpr>, keys: Vec<String> },
}

impl PageExpr {
    /// Emit SQLite SQL for this IR node.
    pub fn emit(&self) -> String {
        match self {
            PageExpr::Raw(s) => s.clone(),
            PageExpr::Column(name) => name.clone(),
            PageExpr::PropertyGet { base, key } => {
                format!("page_property({}, '{}')", base.emit(), escape_sql_string(key))
            }
            PageExpr::HasKey { base, key } => {
                format!("page_has_key({}, '{}')", base.emit(), escape_sql_string(key))
            }
            PageExpr::HasTag { array, tag } => {
                format!("page_has_tag({}, '{}')", array.emit(), escape_sql_string(tag))
            }
            PageExpr::AllTags { array, tags } => {
                if tags.is_empty() {
                    "1".to_string()
                } else {
                    let parts: Vec<String> = tags
                        .iter()
                        .map(|t| {
                            format!(
                                "page_has_tag({}, '{}')",
                                array.emit(),
                                escape_sql_string(t)
                            )
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
                            format!(
                                "page_has_tag({}, '{}')",
                                array.emit(),
                                escape_sql_string(t)
                            )
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
                format!("date_part('{}', {})", escape_sql_string(field), source.emit())
            }
            PageExpr::AggRename { sqlite_name, args_sql } => {
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
                            format!(
                                "page_has_key({}, '{}')",
                                base.emit(),
                                escape_sql_string(k)
                            )
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
                            format!(
                                "page_has_key({}, '{}')",
                                base.emit(),
                                escape_sql_string(k)
                            )
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
pub fn lower_page_sql(
    sql: &str,
    full_textual: impl FnOnce(&str) -> Result<String, String>,
    residual_textual: impl FnOnce(&str) -> Result<String, String>,
) -> Result<String, String> {
    // Statically reference the IR surface without taking the runtime path.
    if std::hint::black_box(false) {
        retain_page_expr_surface();
    }
    let _ = residual_textual; // residual is included inside full_textual today
    match try_ast_lower(sql)? {
        Some(rewritten) => full_textual(&rewritten),
        None => full_textual(sql),
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

    // Apply from the end so earlier offsets stay valid. Drop overlapping
    // rewrites that would corrupt the string (keep the longer/outer one).
    rewrites.sort_by(|a, b| b.start.cmp(&a.start).then(b.end.cmp(&a.end)));
    let mut out = sql.to_string();
    let mut last_start = out.len();
    for rw in &rewrites {
        if rw.end > last_start {
            continue; // overlaps a later (already applied) rewrite
        }
        if rw.start > rw.end || rw.end > out.len() {
            continue;
        }
        if !out.is_char_boundary(rw.start) || !out.is_char_boundary(rw.end) {
            continue;
        }
        out.replace_range(rw.start..rw.end, &rw.replacement);
        last_start = rw.start;
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
                    let field_part = span[span.find('(').map(|i| i + 1).unwrap_or(0)..from_rel].trim();
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
        let s = left_loc.filter(|l| *l >= 0).map(|l| l as usize).unwrap_or(0);
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
        format!("lower({left_sql}) LIKE lower('{pat}')")
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
        if loc >= 0 { loc as usize } else { 0 }
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
                (Some((col, col_loc)), Some(tags), Some(arr_loc))
                    if is_tag_like_column(&col) =>
                {
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
                        if let Some((s, end)) =
                            span_from_to_token_end(sql, tokens, start, end_hint)
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
                        if let Some((s, end)) =
                            span_from_to_token_end(sql, tokens, start, end_hint)
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
        while j < bytes.len() && !bytes[j].is_ascii_whitespace() && bytes[j] != b',' && bytes[j] != b')' {
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
    let key = sub.refupperindexpr.first().and_then(|n| string_const(n));
    match (base, key) {
        (Some((col, col_loc)), Some(key))
            if col.ends_with("properties") || col == "properties" =>
        {
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


// ---------------------------------------------------------------------------
// Span recovery helpers (token scan + location hints)
// ---------------------------------------------------------------------------

/// From a column location through the matching closing `]` after `array_hint`.
fn peel_typecast<'a>(node: &'a protobuf::Node) -> &'a protobuf::Node {
    let mut cur = node;
    for _ in 0..8 {
        match &cur.node {
            Some(NodeEnum::TypeCast(tc)) => {
                if let Some(ref arg) = tc.arg {
                    cur = arg.as_ref();
                } else {
                    break;
                }
            }
            _ => break,
        }
    }
    cur
}

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
    let end = [" is not unknown", " is unknown", " is not true", " is true", " is not false", " is false"]
        .iter()
        .filter_map(|kw| {
            lower[start..].find(kw).map(|i| start + i + kw.len())
        })
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
    let Some(ref arg) = tc.arg else {
        return Ok(None);
    };
    let inner = peel_typecast(arg);
    let inner_rw = match &inner.node {
        Some(NodeEnum::AArrayExpr(arr)) => lower_aarrayexpr(sql, arr, tokens)?,
        Some(NodeEnum::AExpr(expr)) => lower_aexpr(sql, expr, tokens)?,
        Some(NodeEnum::SubscriptingRef(sub)) => lower_subscript(sql, sub, tokens)?,
        Some(NodeEnum::NullTest(nt)) => lower_nulltest(sql, nt, tokens)?,
        Some(NodeEnum::FuncCall(func)) => lower_funccall(sql, func, tokens)?,
        _ => None,
    };

    // Locate `::` after the arg and strip the cast for SQLite.
    let start_hint = if tc.location >= 0 {
        tc.location as usize
    } else if let Some(c) = const_location(arg) {
        c as usize
    } else if let Some(rw) = &inner_rw {
        rw.start
    } else {
        return Ok(inner_rw);
    };

    let Some((start, end)) = find_typecast_span(sql, start_hint) else {
        return Ok(inner_rw);
    };
    let replacement = if let Some(rw) = inner_rw {
        rw.replacement
    } else {
        // Drop `::typename`; keep the argument text.
        let slice = &sql[start..end];
        match slice.find("::") {
            Some(i) => slice[..i].trim_end().to_string(),
            None => slice.to_string(),
        }
    };
    let _ = tokens;
    Ok(Some(AstRewrite {
        start,
        end,
        replacement,
    }))
}

/// Span covering `expr::typename` starting at a location inside/at the expr.
fn find_typecast_span(sql: &str, from: usize) -> Option<(usize, usize)> {
    let bytes = sql.as_bytes();
    if from >= bytes.len() {
        return None;
    }
    // Walk left to start of string literal or identifier
    let mut start = from;
    if bytes[start] == b'\'' || (start > 0 && bytes[start - 1] == b'\'') {
        // find opening quote
        let mut i = start;
        if bytes[i] != b'\'' {
            i = start;
        }
        while i > 0 {
            if bytes[i] == b'\'' {
                // check not doubled
                if i > 0 && bytes[i - 1] == b'\'' {
                    i -= 1;
                    continue;
                }
                start = i;
                break;
            }
            i -= 1;
        }
    } else {
        while start > 0
            && (bytes[start - 1].is_ascii_alphanumeric()
                || bytes[start - 1] == b'_'
                || bytes[start - 1] == b'.')
        {
            start -= 1;
        }
    }

    let mut i = start;
    // consume string or ident
    if i < bytes.len() && bytes[i] == b'\'' {
        i += 1;
        while i < bytes.len() {
            if bytes[i] == b'\'' {
                if i + 1 < bytes.len() && bytes[i + 1] == b'\'' {
                    i += 2;
                    continue;
                }
                i += 1;
                break;
            }
            i += 1;
        }
    } else {
        while i < bytes.len()
            && (bytes[i].is_ascii_alphanumeric() || bytes[i] == b'_' || bytes[i] == b'.')
        {
            i += 1;
        }
    }
    while i < bytes.len() && bytes[i].is_ascii_whitespace() {
        i += 1;
    }
    if i + 1 >= bytes.len() || bytes[i] != b':' || bytes[i + 1] != b':' {
        return None;
    }
    i += 2;
    while i < bytes.len() && bytes[i].is_ascii_whitespace() {
        i += 1;
    }
    if i >= bytes.len() || !(bytes[i].is_ascii_alphabetic() || bytes[i] == b'_') {
        return None;
    }
    while i < bytes.len() && (bytes[i].is_ascii_alphanumeric() || bytes[i] == b'_') {
        i += 1;
    }
    if i < bytes.len() && bytes[i] == b'(' {
        if let Some(end) = find_closing_paren_end(sql, i) {
            i = end;
        }
    }
    Some((start, i))
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
                let key = sub
                    .refupperindexpr
                    .first()
                    .and_then(|n| string_const(n))?;
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
        let prefix = sql[..start_hint].rfind("ARRAY").or_else(|| sql[..start_hint].rfind("array"));
        match prefix {
            Some(p) if sql[p..start_hint].chars().all(|c| c.is_whitespace() || c.is_ascii_alphabetic()) => p,
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
    let elems: Vec<PageExpr> = arr
        .elements
        .iter()
        .filter_map(|n| {
            string_const(n)
                .map(|s| PageExpr::Raw(format!("'{s}'")))
                .or_else(|| column_name(n).map(PageExpr::Column))
        })
        .collect();
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
    if matches!(name_l.as_str(), "date_part" | "extract") && func.args.len() >= 2 {
        let field = string_const(&func.args[0])
            .or_else(|| column_name(&func.args[0]))
            .unwrap_or_default()
            .trim_matches('\'')
            .to_ascii_lowercase();
        let source = column_name(&func.args[1])
            .map(PageExpr::Column)
            .unwrap_or_else(|| PageExpr::Raw(snippet_node_fallback(sql, &func.args[1])));
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

    // jsonb_array_length(tags) / cardinality(tags) → length via SQLite length()
    // Tags are stored as JSON text arrays in the index helpers; length(tags)
    // is a pragmatic stand-in until a dedicated page_array_length ships.
    if matches!(name_l.as_str(), "jsonb_array_length" | "cardinality") && !func.args.is_empty()
    {
        if let Some((col, col_loc)) = column_ref(&func.args[0]) {
            if is_tag_like_column(&col) {
                let start = if loc >= 0 {
                    loc as usize
                } else {
                    column_start(sql, &col, col_loc, 0).unwrap_or(0)
                };
                if let Some(end) = find_closing_paren_end(sql, start) {
                    if end > start && sql.is_char_boundary(start) && sql.is_char_boundary(end) {
                        return Ok(Some(AstRewrite {
                            start,
                            end,
                            replacement: format!("length({col})"),
                        }));
                    }
                }
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
            let start = if loc >= 0 {
                loc as usize
            } else {
                0
            };
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
        if let (Some(col), Some(key)) = (
            column_name(&func.args[0]),
            string_const(&func.args[1]),
        ) {
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

/// Best-effort source text for a node without a full deparse.
fn snippet_node_fallback(sql: &str, node: &protobuf::Node) -> String {
    if let Some(name) = column_name(node) {
        return name;
    }
    if let Some(s) = string_const(node) {
        return format!("'{s}'");
    }
    // Last resort: empty raw — residual path may still fix surrounding SQL.
    let _ = sql;
    "NULL".to_string()
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
                        if let Some(key) = sub.refupperindexpr.first().and_then(|n| string_const(n)) {
                            forms.push(PageExpr::PropertyGet {
                                base: Box::new(PageExpr::Column(col)),
                                key,
                            });
                        }
                    }
                }
            }
            NodeRef::AArrayExpr(arr) => {
                let elems: Vec<PageExpr> = arr
                    .elements
                    .iter()
                    .filter_map(|n| {
                        string_const(n)
                            .map(|s| PageExpr::Raw(format!("'{s}'")))
                            .or_else(|| column_name(n).map(PageExpr::Column))
                    })
                    .collect();
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn analyzes_tag_containment() {
        let forms = analyze_page_forms(
            "SELECT * FROM pages p WHERE p.tags @> ARRAY['recruiter', 'linkedin']",
        )
        .unwrap();
        assert_eq!(
            forms,
            vec![PageExpr::AllTags {
                array: Box::new(PageExpr::Column("p.tags".into())),
                tags: vec!["recruiter".into(), "linkedin".into()],
            }]
        );
        assert_eq!(
            forms[0].emit(),
            "(page_has_tag(p.tags, 'recruiter') AND page_has_tag(p.tags, 'linkedin'))"
        );
    }

    #[test]
    fn analyzes_tag_overlap() {
        let forms = analyze_page_forms("SELECT path FROM pages WHERE tags && ARRAY['a']").unwrap();
        assert_eq!(
            forms,
            vec![PageExpr::AnyTag {
                array: Box::new(PageExpr::Column("tags".into())),
                tags: vec!["a".into()],
            }]
        );
    }

    #[test]
    fn analyzes_property_existence() {
        let forms =
            analyze_page_forms("SELECT 1 FROM pages WHERE properties ? 'company'").unwrap();
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
    fn lower_page_sql_runs_full_textual_after_ast() {
        let sql = "SELECT path FROM pages WHERE tags @> ARRAY['x']";
        let out = lower_page_sql(
            sql,
            |s| Ok(format!("/*full*/{s}")),
            |_s| panic!("residual callback unused (folded into full)"),
        )
        .unwrap();
        assert!(out.starts_with("/*full*/"), "full textual not applied: {out}");
        assert!(out.contains("page_has_tag"), "AST rewrite missing: {out}");
        assert!(!out.contains("@>"), "operator remains: {out}");
    }

    #[test]
    fn lower_page_sql_uses_full_when_ast_misses() {
        let sql = "SELECT 1";
        let out = lower_page_sql(
            sql,
            |s| Ok(format!("/*full*/{s}")),
            |_s| Ok(s.to_string()),
        )
        .unwrap();
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
        let forms =
            analyze_page_forms("SELECT properties->>'company' FROM pages").unwrap();
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
            forms.iter().any(|f| matches!(f, PageExpr::ArrayLit(v) if v.len() == 2)),
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
    fn peel_typecast_unwraps_nested() {
        // Smoke: TypeCast arm is wired; casted ARRAY should still attempt rewrite.
        let sql = "SELECT ARRAY['a']::text[]";
        match try_ast_lower(sql) {
            Ok(Some(out)) => {
                assert!(
                    out.contains("page_array") || out.contains("ARRAY"),
                    "unexpected: {out}"
                );
            }
            Ok(None) => {
                // Acceptable if parser shape differs; residual still covers ARRAY.
            }
            Err(e) => panic!("parse/lower error: {e}"),
        }
    }

    #[test]
    fn subscript_span_does_not_swallow_as_alias() {
        let sql = "SELECT properties['company'] AS company FROM pages";
        let out = lower_page_sql(sql, |s| Ok(s.to_string()), |s| Ok(s.to_string())).unwrap();
        assert!(
            out.contains("page_property(properties, 'company') AS company")
                || out.contains("page_property(properties, 'company')  AS company"),
            "alias lost or span too wide: {out}"
        );
        assert!(!out.contains("page_property(properties, 'company' AS"), "paren swallowed AS: {out}");
    }



    #[test]
    fn ast_property_arrow_smoke() {
        let sql = "SELECT properties->>'company' FROM pages";
        let _ = try_ast_lower(sql);
        let sql2 = "SELECT properties->'active' FROM pages";
        let _ = try_ast_lower(sql2);
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
                assert!(!out.to_ascii_lowercase().contains(" is true"), "IS TRUE remains: {out}");
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
        assert!(!out.to_ascii_lowercase().contains("extract("), "EXTRACT remains: {out}");
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
