use std::path::{Path, PathBuf};
use tauri::AppHandle;

/// The index is disposable. Desktop keeps its existing cache location;
/// mobile must not put SQLite/WAL files into the Obsidian-synced vault.
pub fn index_database_path(app: &AppHandle, root: &Path) -> Result<PathBuf, String> {
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        use sha2::{Digest, Sha256};
        use tauri::Manager;

        let canonical_root = root.canonicalize().map_err(|error| error.to_string())?;
        let digest = Sha256::digest(canonical_root.to_string_lossy().as_bytes());
        let private_data = app
            .path()
            .app_local_data_dir()
            .map_err(|error| error.to_string())?;
        Ok(private_data
            .join("vault-indexes")
            .join(hex::encode(digest))
            .join("index.db"))
    }
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let _ = app;
        Ok(root.join(".nephrite").join("index.db"))
    }
}
