use nephrite_index::VaultIndex;
use parking_lot::Mutex;
use std::sync::atomic::AtomicU64;
use std::sync::Arc;

pub struct AppState {
    pub index: Arc<Mutex<Option<VaultIndex>>>,
    /// Incrementing this value retires the watcher for the previously opened
    /// vault without requiring a blocking thread join on the UI command.
    pub watcher_generation: Arc<AtomicU64>,
}
