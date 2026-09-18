//! User-owned sync dependencies. No system installation, shell profile, or npm prerequisite.
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

#[derive(Serialize, Deserialize)]
pub(crate) struct Installation {
    pub node: PathBuf,
    pub cli: PathBuf,
}

pub(crate) fn root() -> Result<PathBuf, String> {
    dirs::data_local_dir()
        .map(|p| p.join("Nephrite/sync-runtime"))
        .ok_or_else(|| {
            "Could not resolve the application data directory for sync installation".into()
        })
}

pub(crate) fn installed() -> Option<Installation> {
    read_installation(&root().ok()?)
}

fn read_installation(root: &Path) -> Option<Installation> {
    let data = fs::read(root.join("installation.json")).ok()?;
    let install: Installation = serde_json::from_slice(&data).ok()?;
    (install.node.is_file() && install.cli.is_file()).then_some(install)
}

pub(crate) fn quiet(command: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    #[cfg(not(windows))]
    let _ = command;
}

impl Installation {
    fn node_command(&self) -> Command {
        let mut command = Command::new(&self.node);
        let mut paths = vec![self.node.parent().unwrap().to_path_buf()];
        paths.extend(std::env::split_paths(
            &std::env::var_os("PATH").unwrap_or_default(),
        ));
        if let Ok(path) = std::env::join_paths(paths) {
            command.env("PATH", path);
        }
        quiet(&mut command);
        command
    }

    pub fn command(&self) -> Command {
        let mut command = self.node_command();
        command.arg(&self.cli);
        command
    }

    /// Read private CLI arguments from stdin, keeping credentials out of the OS
    /// command line. This bypasses CLI prompts that consume all piped input at once.
    pub fn private_command(&self) -> Command {
        let mut command = self.node_command();
        // Keep normal Node script argument semantics. Commander treats --eval
        // specially and would otherwise mistake the script path for a command.
        let preload = base64::engine::general_purpose::STANDARD.encode(r#"
import { readFileSync } from 'node:fs';
const args = JSON.parse(readFileSync(0, 'utf8'));
if (!Array.isArray(args) || !args.every(arg => typeof arg === 'string')) throw new Error('Invalid private arguments');
process.argv = [process.execPath, process.argv[1], ...args];
"#);
        command
            .arg("--import")
            .arg(format!("data:text/javascript;base64,{preload}"))
            .arg(&self.cli);
        command
    }
}

/// JSON mode never prompts; the encryption password must be an explicit option.
pub(crate) fn setup_args<'a>(
    vault: &'a str,
    path: &'a str,
    device: &'a str,
    password: &'a str,
) -> Vec<&'a str> {
    vec![
        "sync-setup",
        "--vault",
        vault,
        "--path",
        path,
        "--device-name",
        device,
        "--config-dir",
        ".obsidian",
        "--password",
        password,
        "--json",
    ]
}

fn run(command: &mut Command, step: &str) -> Result<(), String> {
    quiet(command);
    let output = command
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("{step}: {e}"))?;
    if output.status.success() {
        return Ok(());
    }
    Err(format!(
        "{step}: {}",
        String::from_utf8_lossy(&output.stderr).trim()
    ))
}

fn npm_for(node: &Path) -> Option<PathBuf> {
    let bin = node.parent()?;
    [
        bin.join("node_modules/npm/bin/npm-cli.js"),
        bin.join("../lib/node_modules/npm/bin/npm-cli.js"),
        bin.join("../share/nodejs/npm/bin/npm-cli.js"),
    ]
    .into_iter()
    .find(|p| p.is_file())
}

pub(crate) fn compatible_node(node: &Path) -> bool {
    let mut command = Command::new(node);
    quiet(&mut command);
    command
        .arg("--version")
        .output()
        .ok()
        .is_some_and(|output| {
            output.status.success()
                && String::from_utf8_lossy(&output.stdout)
                    .trim()
                    .trim_start_matches('v')
                    .split('.')
                    .next()
                    .and_then(|v| v.parse::<u32>().ok())
                    .is_some_and(|major| major >= 22)
        })
}

fn archive_suffix(os: &str, arch: &str) -> Result<String, String> {
    let arch = match arch {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        "x86" => "x86",
        _ => {
            return Err(format!(
                "No bundled sync runtime is available for {os}/{arch}"
            ))
        }
    };
    match os {
        "windows" => Ok(format!("win-{arch}.zip")),
        "linux" | "macos" if arch != "x86" => Ok(format!(
            "{}-{arch}.tar.gz",
            if os == "macos" { "darwin" } else { os }
        )),
        _ => Err(format!(
            "No bundled sync runtime is available for {os}/{arch}"
        )),
    }
}

fn manifest_entry(manifest: &str, suffix: &str) -> Result<(String, String, String), String> {
    let pattern = regex::Regex::new(&format!(
        r"^node-(v22\.\d+\.\d+)-{}$",
        regex::escape(suffix)
    ))
    .unwrap();
    for line in manifest.lines() {
        let fields: Vec<_> = line.split_whitespace().collect();
        if fields.len() != 2
            || fields[0].len() != 64
            || !fields[0].bytes().all(|c| c.is_ascii_hexdigit())
        {
            continue;
        }
        if let Some(capture) = pattern.captures(fields[1]) {
            return Ok((
                fields[0].to_ascii_lowercase(),
                fields[1].into(),
                capture[1].into(),
            ));
        }
    }
    Err(format!(
        "Node download manifest has no valid {suffix} entry"
    ))
}

fn verify_checksum(data: &[u8], expected: &str) -> Result<(), String> {
    if hex::encode(Sha256::digest(data)) == expected {
        Ok(())
    } else {
        Err("Node download checksum mismatch; downloaded code was not run".into())
    }
}

fn provision(root: &Path) -> Result<PathBuf, String> {
    let windows = cfg!(windows);
    let node_relative = if windows { "node.exe" } else { "bin/node" };
    if let Some(existing) = fs::read(root.join("runtime.json"))
        .ok()
        .and_then(|data| serde_json::from_slice::<PathBuf>(&data).ok())
    {
        if compatible_node(&existing) && npm_for(&existing).is_some() {
            return Ok(existing);
        }
    }
    let suffix = archive_suffix(std::env::consts::OS, std::env::consts::ARCH)?;
    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(300))
        .build();
    let manifest = agent
        .get("https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt")
        .call()
        .map_err(|e| format!("Downloading Node manifest: {e}"))?
        .into_string()
        .map_err(|e| e.to_string())?;
    let (checksum, filename, version) = manifest_entry(&manifest, &suffix)?;
    let mut data = Vec::new();
    agent
        .get(&format!("https://nodejs.org/dist/{version}/{filename}"))
        .call()
        .map_err(|e| format!("Downloading Node runtime: {e}"))?
        .into_reader()
        .take(150_000_001)
        .read_to_end(&mut data)
        .map_err(|e| e.to_string())?;
    if data.len() > 150_000_000 {
        return Err("Node download exceeded its size limit".into());
    }
    verify_checksum(&data, &checksum)?;
    let stage = tempfile::tempdir_in(root).map_err(|e| e.to_string())?;
    if windows {
        zip::ZipArchive::new(std::io::Cursor::new(&data))
            .map_err(|e| e.to_string())?
            .extract(stage.path())
            .map_err(|e| format!("Extracting Node: {e}"))?;
    } else {
        tar::Archive::new(flate2::read::GzDecoder::new(data.as_slice()))
            .unpack(stage.path())
            .map_err(|e| format!("Extracting Node: {e}"))?;
    }
    let dirname = filename
        .trim_end_matches(".zip")
        .trim_end_matches(".tar.gz");
    let extracted = stage.path().join(dirname);
    let node = extracted.join(node_relative);
    if !compatible_node(&node) || npm_for(&node).is_none() {
        return Err("Downloaded Node runtime could not start or did not contain npm".into());
    }
    // Keep old generations intact: existing clients may still be using them.
    let destination = root.join(format!(
        "node-{}",
        stage.path().file_name().unwrap().to_string_lossy()
    ));
    fs::rename(extracted, &destination).map_err(|e| e.to_string())?;
    Ok(destination.join(node_relative))
}

pub(crate) fn install(root: &Path, candidates: &[PathBuf]) -> Result<Installation, String> {
    fs::create_dir_all(root).map_err(|e| format!("Creating sync runtime directory: {e}"))?;
    if let Some(existing) = read_installation(root) {
        if run(
            existing.command().arg("--version"),
            "Checking Obsidian Headless",
        )
        .is_ok()
        {
            return Ok(existing);
        }
    }
    let node = match candidates
        .iter()
        .find(|node| compatible_node(node) && npm_for(node).is_some())
    {
        Some(node) => node.clone(),
        None => provision(root)?,
    };
    let node = std::path::absolute(node).map_err(|e| e.to_string())?;
    // Retain a verified runtime across interrupted/failed provider installations.
    save_record(root, "runtime.json", &node)?;
    let npm = npm_for(&node).ok_or("Sync runtime did not contain npm")?;
    let stage = tempfile::tempdir_in(root).map_err(|e| e.to_string())?;
    let prefix = stage.path().join("provider");
    let npm_install = Installation {
        node: node.clone(),
        cli: npm,
    };
    run(
        npm_install
            .command()
            .args(["install", "--global", "--prefix"])
            .arg(&prefix)
            .args(["--no-audit", "--no-fund", "obsidian-headless"]),
        "Installing Obsidian Headless",
    )?;
    let package = prefix.join(if cfg!(windows) {
        "node_modules/obsidian-headless"
    } else {
        "lib/node_modules/obsidian-headless"
    });
    let metadata: serde_json::Value =
        serde_json::from_slice(&fs::read(package.join("package.json")).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    let bin = metadata["bin"]["ob"]
        .as_str()
        .ok_or("Installed package does not provide ob")?;
    let cli = package.join(bin);
    // Canonicalize only for containment checks: Node's Windows entry-point loader
    // does not accept Rust's extended-length (\\?\) canonical path prefix.
    if !cli
        .canonicalize()
        .map_err(|e| e.to_string())?
        .starts_with(package.canonicalize().map_err(|e| e.to_string())?)
    {
        return Err("Invalid ob entry point".into());
    }
    run(
        Installation {
            node: node.clone(),
            cli,
        }
        .command()
        .arg("--version"),
        "Checking installed Obsidian Headless",
    )?;
    let relative = package.strip_prefix(stage.path()).unwrap().join(bin);
    let destination = root.join(format!(
        "provider-{}",
        stage.path().file_name().unwrap().to_string_lossy()
    ));
    fs::rename(stage.path().join("provider"), &destination).map_err(|e| e.to_string())?;
    let install = Installation {
        node,
        cli: destination.join(relative.strip_prefix("provider").unwrap()),
    };
    save_record(root, "installation.json", &install)?;
    Ok(install)
}

fn save_record(root: &Path, name: &str, value: &impl Serialize) -> Result<(), String> {
    let mut record = tempfile::NamedTempFile::new_in(root).map_err(|e| e.to_string())?;
    record
        .write_all(&serde_json::to_vec(value).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    record
        .persist(root.join(name))
        .map_err(|e| format!("Saving sync installation: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn supports_desktop_runtime_targets() {
        for (os, arch, suffix) in [
            ("windows", "x86_64", "win-x64.zip"),
            ("windows", "aarch64", "win-arm64.zip"),
            ("linux", "x86_64", "linux-x64.tar.gz"),
            ("linux", "aarch64", "linux-arm64.tar.gz"),
            ("macos", "x86_64", "darwin-x64.tar.gz"),
            ("macos", "aarch64", "darwin-arm64.tar.gz"),
        ] {
            assert_eq!(archive_suffix(os, arch).unwrap(), suffix);
        }
        assert!(archive_suffix("linux", "unknown").is_err());
    }
    #[test]
    fn manifest_rejects_wrong_platform_traversal_and_bad_hashes() {
        let hash = "a".repeat(64);
        let good = format!("{hash}  node-v22.23.2-win-x64.zip\n");
        assert_eq!(manifest_entry(&good, "win-x64.zip").unwrap().2, "v22.23.2");
        assert!(manifest_entry(&good, "linux-x64.tar.gz").is_err());
        assert!(manifest_entry(&good.replace("node-", "../node-"), "win-x64.zip").is_err());
        assert!(manifest_entry(&good.replace(&hash, "xyz"), "win-x64.zip").is_err());
    }
    #[test]
    fn corrupted_download_is_rejected() {
        let hash = hex::encode(Sha256::digest(b"archive"));
        assert!(verify_checksum(b"archive", &hash).is_ok());
        assert!(verify_checksum(b"changed", &hash).is_err());
    }
    #[test]
    fn missing_runtime_does_not_report_installed() {
        let dir = tempfile::tempdir().unwrap();
        let install = Installation {
            node: dir.path().join("node"),
            cli: dir.path().join("cli.js"),
        };
        fs::write(
            dir.path().join("installation.json"),
            serde_json::to_vec(&install).unwrap(),
        )
        .unwrap();
        assert!(read_installation(dir.path()).is_none());
        fs::write(&install.node, "node").unwrap();
        fs::write(&install.cli, "cli").unwrap();
        assert!(read_installation(dir.path()).is_some());
    }
}
