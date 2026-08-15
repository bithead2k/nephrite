use nephrite_index::VaultIndex;
use parking_lot::Mutex;
use std::collections::HashSet;
use std::sync::atomic::AtomicU64;
use std::sync::Arc;

/// Paths the UI is looking at. The background indexer skips these until the
/// rest of the vault is done so on-screen notes stay readable.
pub struct VisiblePages {
    paths: Mutex<HashSet<String>>,
}

impl VisiblePages {
    pub fn new() -> Self {
        Self {
            paths: Mutex::new(HashSet::new()),
        }
    }

    pub fn set(&self, paths: impl IntoIterator<Item = String>) {
        *self.paths.lock() = paths.into_iter().filter(|path| !path.is_empty()).collect();
    }

    pub fn snapshot(&self) -> HashSet<String> {
        self.paths.lock().clone()
    }
}

pub struct AppState {
    pub index: Arc<Mutex<Option<VaultIndex>>>,
    pub visible: Arc<VisiblePages>,
    /// Incrementing this value retires the watcher for the previously opened
    /// vault without requiring a blocking thread join on the UI command.
    pub watcher_generation: Arc<AtomicU64>,
}
