use serde::{Deserialize, Serialize};
#[cfg(target_os = "android")]
use std::collections::VecDeque;
#[cfg(target_os = "android")]
use std::path::{Path, PathBuf};

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoragePermission {
    pub granted: bool,
}

#[cfg(target_os = "android")]
mod android {
    use super::StoragePermission;
    use tauri::{plugin::PluginHandle, AppHandle, Manager, Runtime};

    pub struct MobileStorage<R: Runtime>(pub PluginHandle<R>);

    pub fn init<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
        tauri::plugin::Builder::new("mobile-storage")
            .setup(|app, api| {
                let handle =
                    api.register_android_plugin("dev.nephrite.app", "MobileStoragePlugin")?;
                app.manage(MobileStorage(handle));
                Ok(())
            })
            .build()
    }

    pub fn permission(app: &AppHandle, request: bool) -> Result<StoragePermission, String> {
        let handle = app.state::<MobileStorage<tauri::Wry>>();
        handle
            .0
            .run_mobile_plugin(if request { "request" } else { "status" }, ())
            .map_err(|error| error.to_string())
    }
}

#[tauri::command]
pub fn mobile_storage_permission(app: tauri::AppHandle) -> Result<StoragePermission, String> {
    #[cfg(target_os = "android")]
    return android::permission(&app, false);
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Ok(StoragePermission { granted: true })
    }
}

#[tauri::command]
pub fn mobile_request_storage_permission(
    app: tauri::AppHandle,
) -> Result<StoragePermission, String> {
    #[cfg(target_os = "android")]
    return android::permission(&app, true);
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Ok(StoragePermission { granted: true })
    }
}

#[tauri::command]
pub fn mobile_vault_candidates() -> Result<Vec<String>, String> {
    #[cfg(not(target_os = "android"))]
    return Ok(Vec::new());
    #[cfg(target_os = "android")]
    {
        let root = Path::new("/storage/emulated/0");
        let mut result = Vec::new();
        let mut pending =
            VecDeque::from([(root.join("Documents"), 0usize), (root.join("Obsidian"), 0)]);
        let mut visited = 0usize;
        while let Some((dir, depth)) = pending.pop_front() {
            if visited >= 3000 {
                break;
            }
            visited += 1;
            if !dir.is_dir() {
                continue;
            }
            if dir.join(".obsidian").is_dir() {
                result.push(dir.to_string_lossy().into_owned());
            }
            if depth >= 4 {
                continue;
            }
            let entries =
                std::fs::read_dir(&dir).map_err(|error| format!("{}: {error}", dir.display()))?;
            for entry in entries.flatten() {
                let path: PathBuf = entry.path();
                if path.is_dir() && !entry.file_name().to_string_lossy().starts_with('.') {
                    pending.push_back((path, depth + 1));
                }
            }
        }
        result.sort();
        result.dedup();
        Ok(result)
    }
}

#[cfg(target_os = "android")]
pub use android::init;
