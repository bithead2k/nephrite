//! PostgreSQL built-in compatibility functions for the SQLite query backend.
//!
//! Keep this module honest: functions are registered only when their behavior
//! is useful and predictably PostgreSQL-like for Nephrite page queries.  It is
//! not a dummy `pg_proc` table that advertises routines which cannot execute.

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use chrono::{Datelike, NaiveDate, NaiveDateTime, NaiveTime, Timelike, Utc};
use regex::{Regex, RegexBuilder};
use rusqlite::functions::FunctionFlags;
use rusqlite::types::{Value, ValueRef};
use sha2::{Digest, Sha256};

const SAFE: FunctionFlags =
    FunctionFlags::SQLITE_DETERMINISTIC.union(FunctionFlags::SQLITE_INNOCUOUS);
const INNOCUOUS: FunctionFlags = FunctionFlags::SQLITE_INNOCUOUS;

fn function_error(message: impl std::fmt::Display) -> rusqlite::Error {
    rusqlite::Error::UserFunctionError(Box::new(std::io::Error::new(
        std::io::ErrorKind::InvalidInput,
        message.to_string(),
    )))
}

fn value_text(value: ValueRef<'_>) -> rusqlite::Result<Option<String>> {
    Ok(match value {
        ValueRef::Null => None,
        ValueRef::Integer(value) => Some(value.to_string()),
        ValueRef::Real(value) => Some(value.to_string()),
        ValueRef::Text(value) => Some(
            std::str::from_utf8(value)
                .map_err(function_error)?
                .to_string(),
        ),
        ValueRef::Blob(value) => Some(String::from_utf8_lossy(value).into_owned()),
    })
}

fn json_value(value: ValueRef<'_>) -> rusqlite::Result<serde_json::Value> {
    Ok(match value {
        ValueRef::Null => serde_json::Value::Null,
        ValueRef::Integer(value) => value.into(),
        ValueRef::Real(value) => serde_json::Number::from_f64(value)
            .map(serde_json::Value::Number)
            .unwrap_or(serde_json::Value::Null),
        ValueRef::Text(value) => serde_json::Value::String(
            std::str::from_utf8(value)
                .map_err(function_error)?
                .to_string(),
        ),
        ValueRef::Blob(value) => serde_json::Value::String(BASE64.encode(value)),
    })
}

fn chars_slice(source: &str, start: usize, length: usize) -> String {
    source.chars().skip(start).take(length).collect()
}

fn pad(source: &str, target: i64, fill: &str, left: bool) -> String {
    let target = target.max(0) as usize;
    let source_length = source.chars().count();
    if source_length >= target {
        return chars_slice(source, 0, target);
    }
    if fill.is_empty() {
        return source.to_string();
    }
    let needed = target - source_length;
    let padding = fill.chars().cycle().take(needed).collect::<String>();
    if left {
        format!("{padding}{source}")
    } else {
        format!("{source}{padding}")
    }
}

fn trim_chars(source: &str, chars: &str, left: bool, right: bool) -> String {
    let wanted = |character: char| chars.contains(character);
    match (left, right) {
        (true, true) => source.trim_matches(wanted),
        (true, false) => source.trim_start_matches(wanted),
        (false, true) => source.trim_end_matches(wanted),
        _ => source,
    }
    .to_string()
}

fn regex_with_flags(pattern: &str, flags: &str) -> rusqlite::Result<Regex> {
    let mut builder = RegexBuilder::new(pattern);
    for flag in flags.chars() {
        match flag {
            'g' => {}
            'i' => {
                builder.case_insensitive(true);
            }
            'm' | 'n' => {
                builder.multi_line(true);
            }
            's' => {
                builder.dot_matches_new_line(true);
            }
            'x' => {
                builder.ignore_whitespace(true);
            }
            other => return Err(function_error(format!("unsupported regexp flag: {other}"))),
        }
    }
    builder.build().map_err(function_error)
}

fn parse_date_time(source: &str) -> Option<NaiveDateTime> {
    [
        "%Y-%m-%d %H:%M:%S%.f",
        "%Y-%m-%dT%H:%M:%S%.f",
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%dT%H:%M:%S",
    ]
    .iter()
    .find_map(|format| NaiveDateTime::parse_from_str(source, format).ok())
    .or_else(|| {
        NaiveDate::parse_from_str(source, "%Y-%m-%d")
            .ok()
            .and_then(|date| date.and_hms_opt(0, 0, 0))
    })
}

fn date_field(field: &str, source: &str) -> rusqlite::Result<f64> {
    let value = parse_date_time(source)
        .ok_or_else(|| function_error(format!("invalid timestamp: {source}")))?;
    Ok(match field.to_ascii_lowercase().as_str() {
        "year" => value.year() as f64,
        "quarter" => ((value.month() - 1) / 3 + 1) as f64,
        "month" => value.month() as f64,
        "week" => value.iso_week().week() as f64,
        "day" => value.day() as f64,
        "dow" => value.weekday().num_days_from_sunday() as f64,
        "isodow" => value.weekday().number_from_monday() as f64,
        "doy" => value.ordinal() as f64,
        "hour" => value.hour() as f64,
        "minute" => value.minute() as f64,
        "second" => value.second() as f64 + value.nanosecond() as f64 / 1_000_000_000.0,
        "epoch" => value.and_utc().timestamp_micros() as f64 / 1_000_000.0,
        other => return Err(function_error(format!("unsupported date part: {other}"))),
    })
}

fn register_text(connection: &rusqlite::Connection) -> Result<(), String> {
    for name in ["char_length", "character_length"] {
        connection
            .create_scalar_function(name, 1, SAFE, |context| {
                Ok(context.get::<String>(0)?.chars().count() as i64)
            })
            .map_err(|error| error.to_string())?;
    }
    connection
        .create_scalar_function("octet_length", 1, SAFE, |context| match context.get_raw(0) {
            ValueRef::Blob(value) | ValueRef::Text(value) => Ok(value.len() as i64),
            value => Ok(value_text(value)?.map(|value| value.len() as i64).unwrap_or(0)),
        })
        .map_err(|error| error.to_string())?;
    connection
        .create_scalar_function("bit_length", 1, SAFE, |context| match context.get_raw(0) {
            ValueRef::Blob(value) | ValueRef::Text(value) => Ok((value.len() * 8) as i64),
            value => Ok(value_text(value)?.map(|value| (value.len() * 8) as i64).unwrap_or(0)),
        })
        .map_err(|error| error.to_string())?;
    connection
        .create_scalar_function("ascii", 1, SAFE, |context| {
            Ok(context
                .get::<String>(0)?
                .chars()
                .next()
                .map(|value| value as i64))
        })
        .map_err(|error| error.to_string())?;
    connection
        .create_scalar_function("chr", 1, SAFE, |context| {
            let code = u32::try_from(context.get::<i64>(0)?).map_err(function_error)?;
            if code == 0 {
                return Err(function_error("chr(0) is not valid PostgreSQL text"));
            }
            char::from_u32(code)
                .map(|value| value.to_string())
                .ok_or_else(|| function_error("invalid Unicode code point"))
        })
        .map_err(|error| error.to_string())?;
    connection
        .create_scalar_function("concat", -1, SAFE, |context| {
            let mut result = String::new();
            for index in 0..context.len() {
                if let Some(value) = value_text(context.get_raw(index))? {
                    result.push_str(&value);
                }
            }
            Ok(result)
        })
        .map_err(|error| error.to_string())?;
    for name in ["concat_ws", "ws_concat"] {
        connection
            .create_scalar_function(name, -1, SAFE, |context| {
                if context.len() == 0 || matches!(context.get_raw(0), ValueRef::Null) {
                    return Ok(None);
                }
                let separator = context.get::<String>(0)?;
                let mut values = Vec::new();
                for index in 1..context.len() {
                    if let Some(value) = value_text(context.get_raw(index))? {
                        values.push(value);
                    }
                }
                Ok(Some(values.join(&separator)))
            })
            .map_err(|error| error.to_string())?;
    }
    connection
        .create_scalar_function("initcap", 1, SAFE, |context| {
            let mut in_word = false;
            Ok(context
                .get::<String>(0)?
                .chars()
                .flat_map(|character| {
                    if character.is_alphanumeric() {
                        let mapped = if in_word {
                            character.to_lowercase().collect::<Vec<_>>()
                        } else {
                            in_word = true;
                            character.to_uppercase().collect::<Vec<_>>()
                        };
                        mapped
                    } else {
                        in_word = false;
                        vec![character]
                    }
                })
                .collect::<String>())
        })
        .map_err(|error| error.to_string())?;
    connection
        .create_scalar_function("casefold", 1, SAFE, |context| {
            Ok(context.get::<String>(0)?.to_lowercase())
        })
        .map_err(|error| error.to_string())?;
    for (name, from_left) in [("left", true), ("right", false)] {
        connection
            .create_scalar_function(name, 2, SAFE, move |context| {
                let source = context.get::<String>(0)?;
                let count = context.get::<i64>(1)?;
                let length = source.chars().count();
                let (start, take) = if from_left {
                    if count >= 0 {
                        (0, (count as usize).min(length))
                    } else {
                        (0, length.saturating_sub(count.unsigned_abs() as usize))
                    }
                } else if count >= 0 {
                    let take = (count as usize).min(length);
                    (length - take, take)
                } else {
                    let drop = (count.unsigned_abs() as usize).min(length);
                    (drop, length - drop)
                };
                Ok(chars_slice(&source, start, take))
            })
            .map_err(|error| error.to_string())?;
    }
    for (name, left) in [("lpad", true), ("rpad", false)] {
        connection
            .create_scalar_function(name, 2, SAFE, move |context| {
                Ok(pad(
                    &context.get::<String>(0)?,
                    context.get::<i64>(1)?,
                    " ",
                    left,
                ))
            })
            .map_err(|error| error.to_string())?;
        connection
            .create_scalar_function(name, 3, SAFE, move |context| {
                Ok(pad(
                    &context.get::<String>(0)?,
                    context.get::<i64>(1)?,
                    &context.get::<String>(2)?,
                    left,
                ))
            })
            .map_err(|error| error.to_string())?;
    }
    connection
        .create_scalar_function("overlay", -1, SAFE, |context| {
            let source = context.get::<String>(0)?;
            let replacement = context.get::<String>(1)?;
            let start = context.get::<i64>(2)?.max(1) as usize - 1;
            let count = if context.len() > 3 {
                context.get::<i64>(3)?.max(0) as usize
            } else {
                replacement.chars().count()
            };
            let source_length = source.chars().count();
            Ok(format!(
                "{}{}{}",
                chars_slice(&source, 0, start.min(source_length)),
                replacement,
                chars_slice(
                    &source,
                    start.saturating_add(count).min(source_length),
                    source_length
                )
            ))
        })
        .map_err(|error| error.to_string())?;
    connection
        .create_scalar_function("repeat", 2, SAFE, |context| {
            Ok(context
                .get::<String>(0)?
                .repeat(context.get::<i64>(1)?.max(0) as usize))
        })
        .map_err(|error| error.to_string())?;
    connection
        .create_scalar_function("reverse", 1, SAFE, |context| {
            Ok(context.get::<String>(0)?.chars().rev().collect::<String>())
        })
        .map_err(|error| error.to_string())?;
    connection
        .create_scalar_function("strpos", 2, SAFE, |context| {
            let source = context.get::<String>(0)?;
            let wanted = context.get::<String>(1)?;
            Ok(source
                .find(&wanted)
                .map(|byte| source[..byte].chars().count() as i64 + 1)
                .unwrap_or(0))
        })
        .map_err(|error| error.to_string())?;
    for (name, left, right) in [
        ("btrim", true, true),
        ("ltrim", true, false),
        ("rtrim", false, true),
    ] {
        connection
            .create_scalar_function(name, 1, SAFE, move |context| {
                Ok(trim_chars(&context.get::<String>(0)?, " ", left, right))
            })
            .map_err(|error| error.to_string())?;
        connection
            .create_scalar_function(name, 2, SAFE, move |context| {
                Ok(trim_chars(
                    &context.get::<String>(0)?,
                    &context.get::<String>(1)?,
                    left,
                    right,
                ))
            })
            .map_err(|error| error.to_string())?;
    }
    connection
        .create_scalar_function("split_part", 3, SAFE, |context| {
            let source = context.get::<String>(0)?;
            let delimiter = context.get::<String>(1)?;
            let index = context.get::<i64>(2)?;
            if index == 0 {
                return Err(function_error("split_part field position must not be zero"));
            }
            let fields = source.split(&delimiter).collect::<Vec<_>>();
            let offset = if index > 0 {
                usize::try_from(index - 1).ok()
            } else {
                fields.len().checked_sub(index.unsigned_abs() as usize)
            };
            Ok(offset
                .and_then(|offset| fields.get(offset))
                .copied()
                .unwrap_or("")
                .to_string())
        })
        .map_err(|error| error.to_string())?;
    for (name, starts) in [("starts_with", true), ("ends_with", false)] {
        connection
            .create_scalar_function(name, 2, SAFE, move |context| {
                let source = context.get::<String>(0)?;
                let affix = context.get::<String>(1)?;
                Ok(if starts {
                    source.starts_with(&affix)
                } else {
                    source.ends_with(&affix)
                })
            })
            .map_err(|error| error.to_string())?;
    }
    connection
        .create_scalar_function("translate", 3, SAFE, |context| {
            let source = context.get::<String>(0)?;
            let from = context.get::<String>(1)?.chars().collect::<Vec<_>>();
            let to = context.get::<String>(2)?.chars().collect::<Vec<_>>();
            Ok(source
                .chars()
                .filter_map(|character| match from.iter().position(|value| *value == character) {
                    Some(index) => to.get(index).copied(),
                    None => Some(character),
                })
                .collect::<String>())
        })
        .map_err(|error| error.to_string())?;
    for name in ["quote_literal", "quote_nullable"] {
        let nullable = name == "quote_nullable";
        connection
            .create_scalar_function(name, 1, SAFE, move |context| {
                match value_text(context.get_raw(0))? {
                    Some(value) => Ok(Some(format!("'{}'", value.replace('\'', "''")))),
                    None if nullable => Ok(Some("NULL".to_string())),
                    None => Ok(None),
                }
            })
            .map_err(|error| error.to_string())?;
    }
    connection
        .create_scalar_function("quote_ident", 1, SAFE, |context| {
            let value = context.get::<String>(0)?;
            let simple = Regex::new(r"^[a-z_][a-z0-9_$]*$").unwrap().is_match(&value);
            Ok(if simple {
                value
            } else {
                format!("\"{}\"", value.replace('"', "\"\""))
            })
        })
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn register_numeric(connection: &rusqlite::Connection) -> Result<(), String> {
    for (name, radix) in [("to_bin", 2_u32), ("to_oct", 8), ("to_hex", 16)] {
        connection
            .create_scalar_function(name, 1, SAFE, move |context| {
                let value = context.get::<i64>(0)?;
                Ok(match radix {
                    2 => format!("{value:b}"),
                    8 => format!("{value:o}"),
                    _ => format!("{value:x}"),
                })
            })
            .map_err(|error| error.to_string())?;
    }
    connection
        .create_scalar_function("pi", 0, SAFE, |_| Ok(std::f64::consts::PI))
        .map_err(|error| error.to_string())?;
    for (name, operation) in [
        ("degrees", f64::to_degrees as fn(f64) -> f64),
        ("radians", f64::to_radians),
        ("cbrt", f64::cbrt),
        ("sqrt", f64::sqrt),
        ("exp", f64::exp),
        ("ln", f64::ln),
        ("log10", f64::log10),
    ] {
        connection
            .create_scalar_function(name, 1, SAFE, move |context| {
                Ok(operation(context.get::<f64>(0)?))
            })
            .map_err(|error| error.to_string())?;
    }
    for name in ["power", "pow"] {
        connection
            .create_scalar_function(name, 2, SAFE, |context| {
                Ok(context
                    .get::<f64>(0)?
                    .powf(context.get::<f64>(1)?))
            })
            .map_err(|error| error.to_string())?;
    }
    connection
        .create_scalar_function("log", 1, SAFE, |context| {
            Ok(context.get::<f64>(0)?.log10())
        })
        .map_err(|error| error.to_string())?;
    connection
        .create_scalar_function("log", 2, SAFE, |context| {
            Ok(context
                .get::<f64>(1)?
                .log(context.get::<f64>(0)?))
        })
        .map_err(|error| error.to_string())?;
    connection
        .create_scalar_function("sign", 1, SAFE, |context| {
            let value = context.get::<f64>(0)?;
            Ok(if value > 0.0 { 1 } else if value < 0.0 { -1 } else { 0 })
        })
        .map_err(|error| error.to_string())?;
    connection
        .create_scalar_function("div", 2, SAFE, |context| {
            let divisor = context.get::<i64>(1)?;
            if divisor == 0 {
                Err(function_error("division by zero"))
            } else {
                Ok(context.get::<i64>(0)? / divisor)
            }
        })
        .map_err(|error| error.to_string())?;
    connection
        .create_scalar_function("mod", 2, SAFE, |context| {
            let divisor = context.get::<i64>(1)?;
            if divisor == 0 {
                Err(function_error("division by zero"))
            } else {
                Ok(context.get::<i64>(0)? % divisor)
            }
        })
        .map_err(|error| error.to_string())?;
    for name in ["gcd", "lcm"] {
        let lcm = name == "lcm";
        connection
            .create_scalar_function(name, 2, SAFE, move |context| {
                let left = context.get::<i64>(0)?;
                let right = context.get::<i64>(1)?;
                let (mut a, mut b) = (left.unsigned_abs(), right.unsigned_abs());
                while b != 0 {
                    (a, b) = (b, a % b);
                }
                if lcm {
                    if a == 0 {
                        Ok(0_i64)
                    } else {
                        left.unsigned_abs()
                            .checked_div(a)
                            .and_then(|value| value.checked_mul(right.unsigned_abs()))
                            .and_then(|value| i64::try_from(value).ok())
                            .ok_or_else(|| function_error("lcm result is out of range"))
                    }
                } else {
                    i64::try_from(a).map_err(function_error)
                }
            })
            .map_err(|error| error.to_string())?;
    }
    connection
        .create_scalar_function("factorial", 1, SAFE, |context| {
            let value = context.get::<i64>(0)?;
            if !(0..=20).contains(&value) {
                return Err(function_error("factorial input must be between 0 and 20"));
            }
            Ok((1..=value).product::<i64>())
        })
        .map_err(|error| error.to_string())?;
    connection
        .create_scalar_function("trunc", 1, SAFE, |context| {
            Ok(context.get::<f64>(0)?.trunc())
        })
        .map_err(|error| error.to_string())?;
    connection
        .create_scalar_function("trunc", 2, SAFE, |context| {
            let value = context.get::<f64>(0)?;
            let digits = context.get::<i64>(1)?;
            let factor = 10_f64.powi(digits.unsigned_abs().min(308) as i32);
            Ok(if digits >= 0 {
                (value * factor).trunc() / factor
            } else {
                (value / factor).trunc() * factor
            })
        })
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn register_conditional(connection: &rusqlite::Connection) -> Result<(), String> {
    for (name, count_nulls) in [("num_nulls", true), ("num_nonnulls", false)] {
        connection
            .create_scalar_function(name, -1, SAFE, move |context| {
                Ok((0..context.len())
                    .filter(|index| {
                        matches!(context.get_raw(*index), ValueRef::Null) == count_nulls
                    })
                    .count() as i64)
            })
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn register_regex(connection: &rusqlite::Connection) -> Result<(), String> {
    connection
        .create_scalar_function("regexp_like", -1, SAFE, |context| {
            let flags = if context.len() > 2 {
                context.get::<String>(2)?
            } else {
                String::new()
            };
            Ok(regex_with_flags(&context.get::<String>(1)?, &flags)?
                .is_match(&context.get::<String>(0)?))
        })
        .map_err(|error| error.to_string())?;
    connection
        .create_scalar_function("regexp_count", -1, SAFE, |context| {
            let source = context.get::<String>(0)?;
            let start = if context.len() > 2 {
                context.get::<i64>(2)?.max(1) as usize - 1
            } else {
                0
            };
            let flags = if context.len() > 3 {
                context.get::<String>(3)?
            } else {
                String::new()
            };
            let source = source.chars().skip(start).collect::<String>();
            Ok(regex_with_flags(&context.get::<String>(1)?, &flags)?
                .find_iter(&source)
                .count() as i64)
        })
        .map_err(|error| error.to_string())?;
    connection
        .create_scalar_function("regexp_substr", -1, SAFE, |context| {
            let source = context.get::<String>(0)?;
            let start = if context.len() > 2 {
                context.get::<i64>(2)?.max(1) as usize - 1
            } else {
                0
            };
            let occurrence = if context.len() > 3 {
                context.get::<i64>(3)?.max(1) as usize
            } else {
                1
            };
            let flags = if context.len() > 4 {
                context.get::<String>(4)?
            } else {
                String::new()
            };
            let subexpression = if context.len() > 5 {
                context.get::<i64>(5)?.max(0) as usize
            } else {
                0
            };
            let tail = source.chars().skip(start).collect::<String>();
            let regex = regex_with_flags(&context.get::<String>(1)?, &flags)?;
            let found = regex
                .captures_iter(&tail)
                .nth(occurrence - 1)
                .and_then(|captures| captures.get(subexpression))
                .map(|value| value.as_str().to_string());
            Ok(found)
        })
        .map_err(|error| error.to_string())?;
    connection
        .create_scalar_function("regexp_replace", -1, SAFE, |context| {
            let source = context.get::<String>(0)?;
            let pattern = context.get::<String>(1)?;
            let replacement = context.get::<String>(2)?.replace("\\&", "$0");
            let flags = if context.len() > 3 {
                context.get::<String>(3)?
            } else {
                String::new()
            };
            let regex = regex_with_flags(&pattern, &flags)?;
            Ok(if flags.contains('g') {
                regex.replace_all(&source, replacement.as_str()).into_owned()
            } else {
                regex.replace(&source, replacement.as_str()).into_owned()
            })
        })
        .map_err(|error| error.to_string())?;
    connection
        .create_scalar_function("regexp_split_to_array", -1, SAFE, |context| {
            let flags = if context.len() > 2 {
                context.get::<String>(2)?
            } else {
                String::new()
            };
            let regex = regex_with_flags(&context.get::<String>(1)?, &flags)?;
            let values = regex
                .split(&context.get::<String>(0)?)
                .map(|value| serde_json::Value::String(value.to_string()))
                .collect::<Vec<_>>();
            serde_json::to_string(&values).map_err(function_error)
        })
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn register_json(connection: &rusqlite::Connection) -> Result<(), String> {
    for name in ["json_typeof", "jsonb_typeof"] {
        connection
            .create_scalar_function(name, 1, SAFE, |context| {
                let value = serde_json::from_str::<serde_json::Value>(&context.get::<String>(0)?)
                    .map_err(function_error)?;
                Ok(match value {
                    serde_json::Value::Null => "null",
                    serde_json::Value::Bool(_) => "boolean",
                    serde_json::Value::Number(_) => "number",
                    serde_json::Value::String(_) => "string",
                    serde_json::Value::Array(_) => "array",
                    serde_json::Value::Object(_) => "object",
                })
            })
            .map_err(|error| error.to_string())?;
    }
    for name in ["json_build_array", "jsonb_build_array"] {
        connection
            .create_scalar_function(name, -1, SAFE, |context| {
                let values = (0..context.len())
                    .map(|index| json_value(context.get_raw(index)))
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                serde_json::to_string(&values).map_err(function_error)
            })
            .map_err(|error| error.to_string())?;
    }
    for name in ["json_build_object", "jsonb_build_object"] {
        connection
            .create_scalar_function(name, -1, SAFE, |context| {
                if context.len() % 2 != 0 {
                    return Err(function_error("json_build_object requires key/value pairs"));
                }
                let mut object = serde_json::Map::new();
                for index in (0..context.len()).step_by(2) {
                    let key = value_text(context.get_raw(index))?
                        .ok_or_else(|| function_error("JSON object key must not be null"))?;
                    object.insert(key, json_value(context.get_raw(index + 1))?);
                }
                serde_json::to_string(&object).map_err(function_error)
            })
            .map_err(|error| error.to_string())?;
    }
    for name in ["to_json", "to_jsonb"] {
        connection
            .create_scalar_function(name, 1, SAFE, |context| {
                serde_json::to_string(&json_value(context.get_raw(0))?).map_err(function_error)
            })
            .map_err(|error| error.to_string())?;
    }
    connection
        .create_scalar_function("json_pretty", 1, SAFE, |context| {
            let value = serde_json::from_str::<serde_json::Value>(&context.get::<String>(0)?)
                .map_err(function_error)?;
            serde_json::to_string_pretty(&value).map_err(function_error)
        })
        .map_err(|error| error.to_string())?;
    for name in ["json_strip_nulls", "jsonb_strip_nulls"] {
        connection
            .create_scalar_function(name, 1, SAFE, |context| {
                fn strip(value: &mut serde_json::Value) {
                    match value {
                        serde_json::Value::Object(object) => {
                            object.retain(|_, value| !value.is_null());
                            object.values_mut().for_each(strip);
                        }
                        serde_json::Value::Array(array) => array.iter_mut().for_each(strip),
                        _ => {}
                    }
                }
                let mut value =
                    serde_json::from_str::<serde_json::Value>(&context.get::<String>(0)?)
                        .map_err(function_error)?;
                strip(&mut value);
                serde_json::to_string(&value).map_err(function_error)
            })
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn register_binary(connection: &rusqlite::Connection) -> Result<(), String> {
    connection
        .create_scalar_function("encode", 2, SAFE, |context| {
            let bytes = match context.get_raw(0) {
                ValueRef::Blob(value) | ValueRef::Text(value) => value,
                _ => return Err(function_error("encode expects bytea/text input")),
            };
            match context.get::<String>(1)?.to_ascii_lowercase().as_str() {
                "base64" => Ok(BASE64.encode(bytes)),
                "hex" => Ok(hex::encode(bytes)),
                "escape" => Ok(String::from_utf8_lossy(bytes).into_owned()),
                format => Err(function_error(format!("unsupported encoding: {format}"))),
            }
        })
        .map_err(|error| error.to_string())?;
    connection
        .create_scalar_function("decode", 2, SAFE, |context| {
            let source = context.get::<String>(0)?;
            match context.get::<String>(1)?.to_ascii_lowercase().as_str() {
                "base64" => BASE64.decode(source).map(Value::Blob).map_err(function_error),
                "hex" => hex::decode(source).map(Value::Blob).map_err(function_error),
                "escape" => Ok(Value::Blob(source.into_bytes())),
                format => Err(function_error(format!("unsupported encoding: {format}"))),
            }
        })
        .map_err(|error| error.to_string())?;
    connection
        .create_scalar_function("sha256", 1, SAFE, |context| {
            let bytes = match context.get_raw(0) {
                ValueRef::Blob(value) | ValueRef::Text(value) => value,
                _ => return Err(function_error("sha256 expects bytea/text input")),
            };
            Ok(Value::Blob(Sha256::digest(bytes).to_vec()))
        })
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn register_datetime(connection: &rusqlite::Connection) -> Result<(), String> {
    for name in ["clock_timestamp", "statement_timestamp", "transaction_timestamp", "now"] {
        connection
            .create_scalar_function(name, 0, INNOCUOUS, |_| {
                Ok(Utc::now().format("%Y-%m-%d %H:%M:%S%.6f+00").to_string())
            })
            .map_err(|error| error.to_string())?;
    }
    connection
        .create_scalar_function("make_date", 3, SAFE, |context| {
            NaiveDate::from_ymd_opt(
                context.get::<i64>(0)? as i32,
                context.get::<i64>(1)? as u32,
                context.get::<i64>(2)? as u32,
            )
            .map(|value| value.format("%Y-%m-%d").to_string())
            .ok_or_else(|| function_error("date field value out of range"))
        })
        .map_err(|error| error.to_string())?;
    connection
        .create_scalar_function("make_time", 3, SAFE, |context| {
            let seconds = context.get::<f64>(2)?;
            let whole = seconds.trunc() as u32;
            let nanos = (seconds.fract() * 1_000_000_000.0).round() as u32;
            NaiveTime::from_hms_nano_opt(
                context.get::<i64>(0)? as u32,
                context.get::<i64>(1)? as u32,
                whole,
                nanos,
            )
            .map(|value| value.format("%H:%M:%S%.f").to_string())
            .ok_or_else(|| function_error("time field value out of range"))
        })
        .map_err(|error| error.to_string())?;
    for name in ["date_part", "extract"] {
        connection
            .create_scalar_function(name, 2, SAFE, |context| {
                date_field(&context.get::<String>(0)?, &context.get::<String>(1)?)
            })
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn register_system(connection: &rusqlite::Connection) -> Result<(), String> {
    for (name, value) in [
        ("version", "PostgreSQL 18 compatible Nephrite SQL on SQLite"),
        ("pg_client_encoding", "UTF8"),
        ("current_database", "nephrite"),
        ("current_schema", "public"),
        ("current_user", "nephrite"),
        ("session_user", "nephrite"),
    ] {
        connection
            .create_scalar_function(name, 0, SAFE, move |_| Ok(value.to_string()))
            .map_err(|error| error.to_string())?;
    }
    connection
        .create_scalar_function("pg_typeof", 1, SAFE, |context| {
            Ok(match context.get_raw(0) {
                ValueRef::Null => "unknown",
                ValueRef::Integer(_) => "bigint",
                ValueRef::Real(_) => "double precision",
                ValueRef::Text(_) => "text",
                ValueRef::Blob(_) => "bytea",
            })
        })
        .map_err(|error| error.to_string())?;
    connection
        .create_scalar_function("nephrite_pg_proc", 0, SAFE, |_| {
            Ok(SUPPORTED_FUNCTIONS.join(","))
        })
        .map_err(|error| error.to_string())?;
    Ok(())
}

pub const SUPPORTED_FUNCTIONS: &[&str] = &[
    "abs", "avg", "bool_and", "bool_or", "coalesce", "count", "every", "length", "lower",
    "max", "min", "nullif", "random", "replace", "round", "string_agg", "substr", "sum", "upper",
    "array_append", "array_cat", "array_dims", "array_length", "array_lower",
    "array_ndims", "array_position", "array_positions", "array_prepend", "array_remove",
    "array_replace", "array_reverse", "array_sort", "array_to_string", "array_upper",
    "ascii", "bit_length", "btrim", "cardinality", "casefold", "cbrt", "char_length",
    "character_length", "chr", "clock_timestamp", "concat", "concat_ws", "ws_concat", "current_database",
    "current_schema", "current_user", "date_part", "decode", "degrees", "div", "encode",
    "ends_with", "exp", "extract", "factorial", "gcd", "initcap", "json_build_array",
    "json_build_object", "json_pretty", "json_strip_nulls", "json_typeof", "jsonb_build_array",
    "jsonb_build_object", "jsonb_strip_nulls", "jsonb_typeof", "lcm", "left", "ln", "log",
    "log10", "lpad", "ltrim", "make_date", "make_time", "mod", "now", "num_nonnulls", "num_nulls",
    "octet_length", "overlay", "pg_client_encoding",
    "pg_typeof", "pi", "pow", "power", "quote_ident", "quote_literal", "quote_nullable",
    "radians", "regexp_count", "regexp_like", "regexp_replace", "regexp_split_to_array",
    "regexp_substr", "repeat", "reverse", "right", "rpad", "rtrim", "session_user", "sha256", "sign",
    "split_part", "sqrt", "starts_with", "statement_timestamp", "string_to_array", "strpos",
    "to_bin", "to_hex", "to_json", "to_jsonb", "to_oct", "transaction_timestamp", "translate",
    "trim_array", "trunc", "version",
];

pub fn register(connection: &rusqlite::Connection) -> Result<(), String> {
    register_text(connection)?;
    register_numeric(connection)?;
    register_conditional(connection)?;
    register_regex(connection)?;
    register_json(connection)?;
    register_binary(connection)?;
    register_datetime(connection)?;
    register_system(connection)?;
    Ok(())
}
