//! File parsers that produce indexable facts.
//! Markdown extraction is intentionally simple for Phase I; CM6/Lezer will own
//! the editor-facing parse surface, and this module will deepen or share logic.

mod markdown;

pub use markdown::{parse_markdown, MarkdownFacts};
