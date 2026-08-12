use std::env;
use std::io::{self, Write};
use std::process::ExitCode;
use std::time::Instant;

use nephrite_index::{ProgressPhase, VaultIndex, PROJECT_VERSION};

fn main() -> ExitCode {
    let mut args = env::args().skip(1);
    let Some(vault) = args.next() else {
        eprintln!("usage: nephrite-index <vault-path>");
        eprintln!("  PROJECT_VERSION {PROJECT_VERSION}");
        return ExitCode::from(2);
    };

    eprintln!("nephrite-index {PROJECT_VERSION}");
    eprintln!("vault: {vault}");
    let start = Instant::now();
    let mut last_line_len = 0usize;

    let result = VaultIndex::open_with_progress(&vault, |phase, done, total, path| {
        let label = match phase {
            ProgressPhase::Scan => "scan",
            ProgressPhase::Index => "index",
            ProgressPhase::Resolve => "resolve",
        };
        let pct = if total > 0 { (done * 100) / total } else { 0 };
        let path = path.unwrap_or("");
        let path = if path.len() > 60 {
            format!("…{}", &path[path.len() - 59..])
        } else {
            path.to_string()
        };
        let line = format!("\r{label:>7} {done}/{total} ({pct}%) {path}");
        let pad = if line.len() < last_line_len {
            " ".repeat(last_line_len - line.len())
        } else {
            String::new()
        };
        last_line_len = line.len();
        eprint!("{line}{pad}");
        let _ = io::stderr().flush();
    });

    eprintln!(); // end progress line

    match result {
        Ok((idx, stats)) => {
            println!("vault: {}", idx.vault_root().display());
            println!(
                "reconcile: scanned={} unchanged={} updated={} removed={} full_rebuild={}",
                stats.scanned, stats.unchanged, stats.updated, stats.removed, stats.full_rebuild
            );
            println!(
                "counts: files={} links={} tasks={} tags={} headings={} properties={}",
                idx.count("files").unwrap_or(0),
                idx.count("links").unwrap_or(0),
                idx.count("tasks").unwrap_or(0),
                idx.count("tags").unwrap_or(0),
                idx.count("headings").unwrap_or(0),
                idx.count("properties").unwrap_or(0),
            );
            eprintln!("done in {:.1}s", start.elapsed().as_secs_f64());
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("error: {e}");
            ExitCode::FAILURE
        }
    }
}
