use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Output, Stdio};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};

const PROVIDER: &str = "obsidian_headless";
const EVENT: &str = "sync-status-changed";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncSettings {
    #[serde(default = "default_provider")]
    pub provider: String,
    #[serde(default)]
    pub continuous: bool,
    #[serde(default)]
    pub remote_vault: String,
    #[serde(default = "default_mode")]
    pub mode: String,
    #[serde(default = "default_conflict")]
    pub conflict_strategy: String,
    #[serde(default)]
    pub file_types: Vec<String>,
    #[serde(default)]
    pub configs: Vec<String>,
    #[serde(default)]
    pub excluded_folders: Vec<String>,
    #[serde(default = "default_device")]
    pub device_name: String,
}

fn default_provider() -> String {
    PROVIDER.into()
}
fn default_mode() -> String {
    "bidirectional".into()
}
fn default_conflict() -> String {
    "merge".into()
}
fn default_device() -> String {
    std::env::var("HOSTNAME")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "nephrite".into())
        + "-nephrite"
}

impl Default for SyncSettings {
    fn default() -> Self {
        Self {
            provider: default_provider(),
            continuous: false,
            remote_vault: String::new(),
            mode: default_mode(),
            conflict_strategy: default_conflict(),
            // Unlike ob's defaults, an empty list cannot unexpectedly pull large videos.
            file_types: Vec::new(),
            configs: Vec::new(),
            excluded_folders: Vec::new(),
            device_name: default_device(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteVault {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub region: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    pub provider: String,
    pub phase: String,
    pub message: String,
    pub active: bool,
    pub synced: bool,
}

impl Default for SyncStatus {
    fn default() -> Self {
        Self {
            provider: PROVIDER.into(),
            phase: "off".into(),
            message: "Sync is off".into(),
            active: false,
            synced: false,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncSnapshot {
    pub settings: SyncSettings,
    pub status: SyncStatus,
    pub vault_path: String,
    pub ob_path: Option<String>,
    pub node_ready: bool,
    pub logged_in: bool,
    pub configured: bool,
    pub settings_saved: bool,
    pub remotes: Vec<RemoteVault>,
    pub provider_settings: Option<ProviderSettings>,
    pub obsidian_settings: Option<ProviderSettings>,
    pub obsidian_settings_error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSettings {
    pub remote_vault: String,
    pub mode: String,
    pub conflict_strategy: String,
    pub file_types: Vec<String>,
    pub configs: Vec<String>,
    pub excluded_folders: Vec<String>,
    pub device_name: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncConfigureRequest {
    pub settings: SyncSettings,
    #[serde(default)]
    pub encryption_password: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncLoginRequest {
    pub email: String,
    pub password: String,
    #[serde(default)]
    pub mfa: String,
}

#[derive(Default)]
struct Runtime {
    pid: Option<u32>,
    status: SyncStatus,
}

#[derive(Clone, Default)]
pub struct SyncManager {
    runtime: Arc<Mutex<Runtime>>,
}

impl SyncManager {
    pub fn status(&self) -> SyncStatus {
        self.runtime.lock().status.clone()
    }

    fn publish(&self, app: &AppHandle, status: SyncStatus) {
        self.runtime.lock().status = status.clone();
        let _ = app.emit(EVENT, status);
    }

    pub fn stop(&self, app: Option<&AppHandle>) {
        let pid = self.runtime.lock().pid.take();
        if let Some(pid) = pid {
            terminate_pid(pid);
        }
        let status = SyncStatus::default();
        self.runtime.lock().status = status.clone();
        if let Some(app) = app {
            let _ = app.emit(EVENT, status);
        }
    }

    pub fn start(&self, app: AppHandle, root: PathBuf, continuous: bool) -> Result<(), String> {
        self.stop(Some(&app));
        let ob = find_ob().ok_or_else(|| {
            "Obsidian Headless is not installed. Open Sync settings and choose Install ob."
                .to_string()
        })?;
        let mut command = Command::new(ob);
        command.args(["sync", "--path"]).arg(&root);
        if continuous {
            command.arg("--continuous");
        }
        command
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .stdin(Stdio::null());
        augment_path(&mut command);
        let mut child = command
            .spawn()
            .map_err(|error| format!("Could not start Obsidian Headless: {error}"))?;
        let pid = child.id();
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        {
            let mut runtime = self.runtime.lock();
            runtime.pid = Some(pid);
        }
        self.publish(
            &app,
            SyncStatus {
                provider: PROVIDER.into(),
                phase: "syncing".into(),
                message: if continuous {
                    "Obsidian Sync is active"
                } else {
                    "Initial Obsidian sync is running"
                }
                .into(),
                active: true,
                synced: false,
            },
        );

        let manager = self.clone();
        std::thread::spawn(move || {
            monitor_child(manager, app, child, stdout, stderr, pid, continuous)
        });
        Ok(())
    }
}

fn monitor_child(
    manager: SyncManager,
    app: AppHandle,
    mut child: Child,
    stdout: Option<impl Read + Send + 'static>,
    stderr: Option<impl Read + Send + 'static>,
    pid: u32,
    continuous: bool,
) {
    let (tx, rx) = std::sync::mpsc::channel::<String>();
    for stream in [
        stdout.map(|s| Box::new(s) as Box<dyn Read + Send>),
        stderr.map(|s| Box::new(s) as Box<dyn Read + Send>),
    ]
    .into_iter()
    .flatten()
    {
        let tx = tx.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stream).lines().map_while(Result::ok) {
                let _ = tx.send(line);
            }
        });
    }
    drop(tx);
    let manager_lines = manager.clone();
    let app_lines = app.clone();
    let lines = std::thread::spawn(move || {
        for line in rx {
            let lower = line.to_ascii_lowercase();
            let (phase, synced) = if lower.contains("fully synced") || lower.contains("up to date")
            {
                ("synced", true)
            } else if lower.contains("error") || lower.contains("failed") {
                ("error", false)
            } else {
                ("syncing", false)
            };
            manager_lines.publish(
                &app_lines,
                SyncStatus {
                    provider: PROVIDER.into(),
                    phase: phase.into(),
                    message: clean_message(&line),
                    active: true,
                    synced,
                },
            );
        }
    });
    let result = child.wait();
    let _ = lines.join();
    let mut runtime = manager.runtime.lock();
    if runtime.pid != Some(pid) {
        return;
    }
    runtime.pid = None;
    let expected_one_shot = !continuous && result.as_ref().is_ok_and(|status| status.success());
    runtime.status = if expected_one_shot {
        SyncStatus {
            provider: PROVIDER.into(),
            phase: "synced".into(),
            message: "Initial sync complete".into(),
            active: false,
            synced: true,
        }
    } else {
        let detail = result
            .map(|status| format!("exit {}", status.code().unwrap_or(-1)))
            .unwrap_or_else(|error| error.to_string());
        SyncStatus {
            provider: PROVIDER.into(),
            phase: "error".into(),
            message: format!("Sync stopped: {detail}"),
            active: false,
            synced: false,
        }
    };
    let status = runtime.status.clone();
    drop(runtime);
    let _ = app.emit(EVENT, status);
}

fn clean_message(line: &str) -> String {
    let text = line.trim();
    if text.chars().count() > 180 {
        format!("{}…", text.chars().take(180).collect::<String>())
    } else if text.is_empty() {
        "Sync activity".into()
    } else {
        text.into()
    }
}

#[cfg(unix)]
fn terminate_pid(pid: u32) {
    unsafe {
        libc::kill(pid as i32, libc::SIGINT);
    }
}

#[cfg(not(unix))]
fn terminate_pid(pid: u32) {
    let _ = Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T"])
        .status();
}

fn settings_path(root: &Path) -> PathBuf {
    root.join(".nephrite").join("sync.json")
}

fn read_varint(bytes: &[u8], offset: &mut usize) -> Option<usize> {
    let mut value = 0usize;
    for shift in (0..35).step_by(7) {
        let byte = *bytes.get(*offset)?;
        *offset += 1;
        value |= usize::from(byte & 0x7f) << shift;
        if byte & 0x80 == 0 {
            return Some(value);
        }
    }
    None
}

fn read_v8_string(bytes: &[u8], offset: &mut usize) -> Option<String> {
    if *bytes.get(*offset)? != 0x22 {
        return None;
    }
    *offset += 1;
    let length = read_varint(bytes, offset)?;
    let value = bytes.get(*offset..(*offset + length))?;
    *offset += length;
    String::from_utf8(value.to_vec()).ok()
}

fn serialized_field(bytes: &[u8], name: &str) -> Option<usize> {
    let mut marker = vec![0x22, u8::try_from(name.len()).ok()?];
    marker.extend_from_slice(name.as_bytes());
    bytes
        .windows(marker.len())
        .position(|window| window == marker)
        .map(|position| position + marker.len())
}

fn dense_string_array(bytes: &[u8], name: &str) -> Option<Vec<String>> {
    let mut offset = serialized_field(bytes, name)?;
    if *bytes.get(offset)? != 0x41 {
        return None;
    }
    offset += 1;
    let count = read_varint(bytes, &mut offset)?;
    (0..count)
        .map(|_| read_v8_string(bytes, &mut offset))
        .collect()
}

fn sparse_string_array(bytes: &[u8], name: &str, next_field: &str) -> Option<Vec<String>> {
    let start = serialized_field(bytes, name)?;
    let end = serialized_field(bytes, next_field)? - next_field.len() - 2;
    let range = bytes.get(start..end)?;
    let mut values = Vec::new();
    let mut offset = 0usize;
    while offset < range.len() {
        if range[offset] == 0x22 {
            let mut candidate = offset;
            if let Some(value) = read_v8_string(range, &mut candidate) {
                values.push(value);
                offset = candidate;
                continue;
            }
        }
        offset += 1;
    }
    Some(values)
}

fn scalar_string(bytes: &[u8], name: &str) -> Option<String> {
    let mut offset = serialized_field(bytes, name)?;
    read_v8_string(bytes, &mut offset)
}

fn collect_files(root: &Path, files: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_files(&path, files);
        } else {
            files.push(path);
        }
    }
}

fn obsidian_settings(root: &Path) -> Result<ProviderSettings, String> {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| "Home directory is unavailable".to_string())?;
    let config_root = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".config"))
        .join("obsidian");
    let registry = fs::read_to_string(config_root.join("obsidian.json"))
        .map_err(|_| "Obsidian's local vault registry was not found".to_string())?;
    let registry: serde_json::Value = serde_json::from_str(&registry)
        .map_err(|_| "Obsidian's local vault registry is unreadable".to_string())?;
    let expected = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    let app_id = registry
        .get("vaults")
        .and_then(serde_json::Value::as_object)
        .and_then(|vaults| {
            vaults.iter().find_map(|(id, entry)| {
                let path = PathBuf::from(entry.get("path")?.as_str()?);
                let path = path.canonicalize().unwrap_or(path);
                (path == expected).then(|| id.clone())
            })
        })
        .ok_or_else(|| "This vault is not registered with Obsidian on this device".to_string())?;
    let mut blobs = Vec::new();
    collect_files(
        &config_root.join("IndexedDB/app_obsidian.md_0.indexeddb.blob"),
        &mut blobs,
    );
    blobs.sort_by_key(|path| fs::metadata(path).and_then(|value| value.modified()).ok());
    let bytes = blobs
        .into_iter()
        .rev()
        .filter_map(|path| fs::read(path).ok())
        .find(|bytes| {
            bytes
                .windows(app_id.len())
                .any(|window| window == app_id.as_bytes())
                && serialized_field(bytes, "allowTypes").is_some()
        })
        .ok_or_else(|| "Obsidian has no readable Sync policy for this vault".to_string())?;
    Ok(ProviderSettings {
        remote_vault: scalar_string(&bytes, "vaultId").unwrap_or_default(),
        mode: "bidirectional".into(),
        conflict_strategy: scalar_string(&bytes, "conflictAction").unwrap_or_default(),
        file_types: dense_string_array(&bytes, "allowTypes").unwrap_or_default(),
        configs: dense_string_array(&bytes, "allowSpecialFiles").unwrap_or_default(),
        excluded_folders: sparse_string_array(&bytes, "ignoreFolders", "preventSleep")
            .unwrap_or_default(),
        device_name: scalar_string(&bytes, "deviceName").unwrap_or_default(),
    })
}

pub fn load_settings(root: &Path) -> SyncSettings {
    fs::read_to_string(settings_path(root))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn save_settings(root: &Path, settings: &SyncSettings) -> Result<(), String> {
    fs::create_dir_all(root.join(".nephrite"))
        .map_err(|error| format!("Could not create Nephrite settings directory: {error}"))?;
    let data = serde_json::to_string_pretty(settings).map_err(|error| error.to_string())? + "\n";
    fs::write(settings_path(root), data)
        .map_err(|error| format!("Could not save sync settings: {error}"))
}

pub fn find_ob() -> Option<PathBuf> {
    find_executable("ob")
}

// Desktop launchers need not inherit shell initialization or a HOME variable.
// dirs uses the OS profile API on Windows and the account database on Unix.
fn executable_directories() -> Vec<PathBuf> {
    let mut directories = std::env::var_os("PATH")
        .map(|path| std::env::split_paths(&path).collect::<Vec<_>>())
        .unwrap_or_default();
    if let Some(home) = dirs::home_dir() {
        directories.extend([home.join("bin"), home.join(".local/bin")]);
        let root = std::env::var_os("NVM_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".nvm"))
            .join("versions/node");
        if let Ok(entries) = fs::read_dir(root) {
            let mut versions = entries
                .flatten()
                .map(|entry| entry.path())
                .collect::<Vec<_>>();
            versions.sort_by_key(|path| {
                path.file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .trim_start_matches('v')
                    .split('.')
                    .map(|part| part.parse::<u32>().unwrap_or_default())
                    .collect::<Vec<_>>()
            });
            directories.extend(versions.into_iter().rev().map(|path| path.join("bin")));
        }
    }
    for name in ["NVM_SYMLINK", "NVM_HOME"] {
        if let Some(path) = std::env::var_os(name) {
            directories.push(PathBuf::from(path));
        }
    }
    if let Some(path) = std::env::var_os("APPDATA") {
        directories.push(PathBuf::from(path).join("npm"));
    }
    if let Some(path) = std::env::var_os("ProgramFiles") {
        directories.push(PathBuf::from(path).join("nodejs"));
    }
    directories
}

fn find_in_directories(name: &str, directories: &[PathBuf], windows: bool) -> Option<PathBuf> {
    let names = if windows {
        // Prefer native executables or cmd shims over extensionless Unix wrappers.
        vec![
            format!("{name}.exe"),
            format!("{name}.cmd"),
            format!("{name}.bat"),
            name.to_string(),
        ]
    } else {
        vec![name.to_string()]
    };
    directories
        .iter()
        .flat_map(|dir| names.iter().map(move |name| dir.join(name)))
        .find(|path| path.is_file())
}

fn find_executable(name: &str) -> Option<PathBuf> {
    find_in_directories(name, &executable_directories(), cfg!(windows))
}

fn augment_path(command: &mut Command) {
    let mut entries = executable_directories();
    if let Some(ob) = find_ob().and_then(|path| path.parent().map(Path::to_path_buf)) {
        entries.insert(0, ob);
    }
    if let Ok(path) = std::env::join_paths(entries) {
        command.env("PATH", path);
    }
    if let Some(home) = dirs::home_dir() {
        command.env("HOME", home);
    }
}

fn run_ob(args: &[&str], input: Option<&str>) -> Result<Output, String> {
    let ob = find_ob().ok_or_else(|| "Obsidian Headless (ob) is not installed".to_string())?;
    let mut command = Command::new(ob);
    command
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    command.stdin(if input.is_some() {
        Stdio::piped()
    } else {
        Stdio::null()
    });
    augment_path(&mut command);
    let mut child = command
        .spawn()
        .map_err(|error| format!("Could not run ob: {error}"))?;
    if let (Some(input), Some(mut stdin)) = (input, child.stdin.take()) {
        stdin
            .write_all(input.as_bytes())
            .map_err(|error| format!("Could not answer ob prompt: {error}"))?;
    }
    child
        .wait_with_output()
        .map_err(|error| format!("Could not wait for ob: {error}"))
}

fn output_text(output: &Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if stderr.is_empty() {
        stdout
    } else {
        stderr
    }
}

fn ensure_success(output: Output, step: &str) -> Result<Output, String> {
    if output.status.success() {
        Ok(output)
    } else {
        let detail = output_text(&output);
        Err(format!(
            "{step} failed{}",
            if detail.is_empty() {
                String::new()
            } else {
                format!(": {detail}")
            }
        ))
    }
}

fn node_ready(provider_installed: bool) -> bool {
    // An installed provider takes precedence over a stale GUI-launcher PATH.
    if provider_installed {
        return true;
    }
    let mut command = match find_executable("node") {
        Some(path) => Command::new(path),
        None => return false,
    };
    let output = command.arg("--version").output().ok();
    output
        .and_then(|value| String::from_utf8(value.stdout).ok())
        .and_then(|value| {
            value
                .trim()
                .trim_start_matches('v')
                .split('.')
                .next()?
                .parse::<u32>()
                .ok()
        })
        .is_some_and(|major| major >= 22)
}

fn remote_vaults() -> Result<Vec<RemoteVault>, String> {
    let output = ensure_success(
        run_ob(&["sync-list-remote", "--json"], None)?,
        "Listing remote vaults",
    )?;
    #[derive(Deserialize)]
    struct Response {
        #[serde(default)]
        vaults: Vec<RemoteVault>,
        #[serde(default)]
        shared: Vec<RemoteVault>,
    }
    let mut response: Response = serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("ob returned invalid vault data: {error}"))?;
    response.vaults.append(&mut response.shared);
    Ok(response.vaults)
}

pub fn snapshot(root: &Path, manager: &SyncManager) -> SyncSnapshot {
    let settings = load_settings(root);
    let settings_saved = settings_path(root).is_file();
    let ob_path = find_ob();
    let remotes = if ob_path.is_some() {
        remote_vaults().unwrap_or_default()
    } else {
        Vec::new()
    };
    let logged_in = !remotes.is_empty();
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct ExistingConfig {
        vault_id: String,
        #[serde(default)]
        sync_mode: String,
        #[serde(default)]
        conflict_strategy: String,
        #[serde(default)]
        device_name: String,
        #[serde(default)]
        file_types: Vec<String>,
        #[serde(default)]
        configs: Vec<String>,
        #[serde(default)]
        excluded_folders: Vec<String>,
    }
    let existing = if ob_path.is_some() {
        run_ob(
            &["sync-status", "--path", &root.to_string_lossy(), "--json"],
            None,
        )
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| serde_json::from_slice::<ExistingConfig>(&output.stdout).ok())
    } else {
        None
    };
    let configured = existing.is_some();
    let provider_settings = existing.map(|existing| ProviderSettings {
        remote_vault: existing.vault_id,
        mode: existing.sync_mode,
        conflict_strategy: existing.conflict_strategy,
        file_types: existing.file_types,
        configs: existing.configs,
        excluded_folders: existing.excluded_folders,
        device_name: existing.device_name,
    });
    let (obsidian_settings, obsidian_settings_error) = match obsidian_settings(root) {
        Ok(settings) => (Some(settings), None),
        Err(error) => (None, Some(error)),
    };
    let mut status = manager.status();
    if !settings.continuous && status.phase == "off" {
        status.message = if configured && !settings_saved {
            "Review and apply sync settings before syncing"
        } else if configured {
            "Ready to sync"
        } else {
            "Sync is not configured"
        }
        .into();
    }
    SyncSnapshot {
        settings,
        status,
        vault_path: root.display().to_string(),
        node_ready: node_ready(ob_path.is_some()),
        ob_path: ob_path.map(|path| path.display().to_string()),
        logged_in,
        configured,
        settings_saved,
        remotes,
        provider_settings,
        obsidian_settings,
        obsidian_settings_error,
    }
}

pub fn install_ob() -> Result<(), String> {
    if find_ob().is_some() {
        return Ok(());
    }
    let home = dirs::home_dir();
    let nvm = std::env::var_os("NVM_DIR")
        .map(PathBuf::from)
        .or_else(|| home.as_ref().map(|home| home.join(".nvm")))
        .map(|path| path.join("nvm.sh"));
    let output = if cfg!(unix) && nvm.as_ref().is_some_and(|path| path.is_file()) {
        let mut command = Command::new("bash");
        augment_path(&mut command);
        command.env("NEPHRITE_NVM_SCRIPT", nvm.as_ref().unwrap())
            .args(["-c", "source \"$NEPHRITE_NVM_SCRIPT\" && nvm install 22 && nvm alias default 22 && npm install -g obsidian-headless"])
            .output().map_err(|error| format!("Could not run nvm/npm: {error}"))?
    } else {
        let npm = find_executable("npm").ok_or_else(|| {
            "Nephrite could not find npm in PATH or your user installation folders. Install Node.js 22 or newer with npm, then retry installation.".to_string()
        })?;
        let mut command = Command::new(npm);
        augment_path(&mut command);
        command
            .args(["install", "-g", "obsidian-headless"])
            .output()
            .map_err(|error| format!("Could not run npm: {error}"))?
    };
    ensure_success(output, "Installing Obsidian Headless")?;
    if find_ob().is_none() {
        return Err("ob was installed, but Nephrite could not find it. Restart Nephrite so it inherits the updated PATH.".into());
    }
    Ok(())
}

pub fn login(request: SyncLoginRequest) -> Result<(), String> {
    if request.email.trim().is_empty() || request.password.is_empty() {
        return Err("Obsidian email and account password are required".into());
    }
    // Prompt input keeps credentials out of the process command line and process list.
    let answers = format!(
        "{}\n{}\n{}\n",
        request.email.trim(),
        request.password,
        request.mfa.trim()
    );
    ensure_success(run_ob(&["login"], Some(&answers))?, "Obsidian login")?;
    Ok(())
}

pub fn configure(
    app: AppHandle,
    root: &Path,
    manager: &SyncManager,
    request: SyncConfigureRequest,
) -> Result<(), String> {
    let settings = request.settings;
    if settings.provider != PROVIDER {
        return Err(format!(
            "Sync provider '{}' is not installed",
            settings.provider
        ));
    }
    if settings.remote_vault.trim().is_empty() {
        return Err("Choose an Obsidian remote vault".into());
    }
    if !root.join(".obsidian").is_dir() {
        return Err("The open folder is not an Obsidian vault (.obsidian was not found)".into());
    }
    manager.stop(Some(&app));
    manager.publish(
        &app,
        SyncStatus {
            provider: PROVIDER.into(),
            phase: "configuring".into(),
            message: "Applying Obsidian Sync settings".into(),
            active: true,
            synced: false,
        },
    );
    let root_text = root.to_string_lossy().to_string();
    let linked_remote = run_ob(&["sync-status", "--path", &root_text, "--json"], None)
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| serde_json::from_slice::<serde_json::Value>(&output.stdout).ok())
        .and_then(|value| value.get("vaultId")?.as_str().map(str::to_string));
    if linked_remote
        .as_deref()
        .is_some_and(|remote| remote != settings.remote_vault)
    {
        ensure_success(
            run_ob(&["sync-unlink", "--path", &root_text], None)?,
            "Unlinking the previous remote vault",
        )?;
    }
    let already_configured = linked_remote.as_deref() == Some(settings.remote_vault.as_str());
    if !already_configured {
        if request.encryption_password.is_empty() {
            return Err("The vault encryption password is required for initial setup".into());
        }
        manager.publish(
            &app,
            SyncStatus {
                provider: PROVIDER.into(),
                phase: "configuring".into(),
                message: "Connecting the local vault to Obsidian Sync".into(),
                active: true,
                synced: false,
            },
        );
        let answers = format!("{}\n", request.encryption_password);
        ensure_success(
            run_ob(
                &[
                    "sync-setup",
                    "--vault",
                    &settings.remote_vault,
                    "--path",
                    &root_text,
                    "--device-name",
                    &settings.device_name,
                    "--config-dir",
                    ".obsidian",
                    "--json",
                ],
                Some(&answers),
            )?,
            "Configuring the Obsidian vault",
        )?;
    }
    let file_types = settings.file_types.join(",");
    let configs = settings.configs.join(",");
    let excluded = settings.excluded_folders.join(",");
    ensure_success(
        run_ob(
            &[
                "sync-config",
                "--path",
                &root_text,
                "--mode",
                &settings.mode,
                "--conflict-strategy",
                &settings.conflict_strategy,
                "--file-types",
                &file_types,
                "--configs",
                &configs,
                "--excluded-folders",
                &excluded,
                "--device-name",
                &settings.device_name,
                "--config-dir",
                ".obsidian",
                "--json",
            ],
            None,
        )?,
        "Applying selective sync settings",
    )?;
    save_settings(root, &settings)?;
    manager.start(app, root.to_path_buf(), settings.continuous)
}

pub fn set_continuous(
    app: AppHandle,
    root: &Path,
    manager: &SyncManager,
    continuous: bool,
) -> Result<(), String> {
    let mut settings = load_settings(root);
    settings.continuous = continuous;
    if continuous {
        if !settings_path(root).is_file() {
            return Err("Review and apply Sync settings before enabling continuous sync".into());
        }
        let configured = run_ob(
            &["sync-status", "--path", &root.to_string_lossy(), "--json"],
            None,
        )
        .is_ok_and(|output| output.status.success());
        if !configured {
            return Err("Finish Obsidian Headless setup before enabling continuous sync".into());
        }
        save_settings(root, &settings)?;
        manager.start(app, root.to_path_buf(), true)
    } else {
        save_settings(root, &settings)?;
        manager.stop(Some(&app));
        Ok(())
    }
}

pub fn sync_once(app: AppHandle, root: &Path, manager: &SyncManager) -> Result<(), String> {
    if !settings_path(root).is_file() {
        return Err("Review and apply Sync settings before syncing".into());
    }
    let configured = run_ob(
        &["sync-status", "--path", &root.to_string_lossy(), "--json"],
        None,
    )
    .is_ok_and(|output| output.status.success());
    if !configured {
        return Err("Finish Obsidian Headless setup before syncing".into());
    }
    manager.start(app, root.to_path_buf(), false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn installed_provider_clears_node_dependency_warning() {
        assert!(node_ready(true));
    }

    #[test]
    fn discovers_windows_npm_shims_in_profile_paths_with_spaces() {
        let temp = tempfile::tempdir().unwrap();
        let bin = temp.path().join("User Profile").join("npm");
        fs::create_dir_all(&bin).unwrap();
        fs::write(bin.join("ob"), "Unix wrapper").unwrap();
        fs::write(bin.join("ob.cmd"), "Windows wrapper").unwrap();
        fs::write(bin.join("npm.cmd"), "npm").unwrap();
        assert_eq!(
            find_in_directories("ob", std::slice::from_ref(&bin), true),
            Some(bin.join("ob.cmd"))
        );
        assert_eq!(
            find_in_directories("npm", std::slice::from_ref(&bin), true),
            Some(bin.join("npm.cmd"))
        );
        assert_eq!(
            find_in_directories("ob", std::slice::from_ref(&bin), false),
            Some(bin.join("ob"))
        );
    }

    #[test]
    fn defaults_do_not_select_large_attachments() {
        let settings = SyncSettings::default();
        assert!(settings.file_types.is_empty());
        assert!(!settings.continuous);
        assert_eq!(settings.provider, PROVIDER);
    }

    #[test]
    fn settings_round_trip_without_a_password() {
        let dir = tempfile::tempdir().unwrap();
        let settings = SyncSettings {
            remote_vault: "journal".into(),
            file_types: vec!["image".into(), "pdf".into()],
            ..SyncSettings::default()
        };
        save_settings(dir.path(), &settings).unwrap();
        let text = fs::read_to_string(settings_path(dir.path())).unwrap();
        assert!(!text.to_ascii_lowercase().contains("password"));
        assert_eq!(load_settings(dir.path()).file_types, settings.file_types);
    }

    #[test]
    fn parses_obsidian_v8_policy_values() {
        let bytes = b"\x22\x0aallowTypesA\x03\x22\x05image\x22\x05audio\x22\x03pdf\x24\x00\x03\x22\x0dignoreFoldersa\x02I\x00\x22\x06videosI\x02\x22\x06.trash@\x02\x02\x22\x0cpreventSleepF";
        assert_eq!(
            dense_string_array(bytes, "allowTypes").unwrap(),
            ["image", "audio", "pdf"]
        );
        assert_eq!(
            sparse_string_array(bytes, "ignoreFolders", "preventSleep").unwrap(),
            ["videos", ".trash"]
        );
    }
}
