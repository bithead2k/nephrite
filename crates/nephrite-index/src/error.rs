use std::path::PathBuf;

use thiserror::Error;

#[derive(Debug, Error)]
pub enum IndexError {
    #[error("sqlite: {0}")]
    Sqlite(#[from] rusqlite::Error),

    #[error("io: {0}")]
    Io(#[from] std::io::Error),

    #[error("vault root is not a directory: {0}")]
    NotADirectory(PathBuf),

    #[error("path escapes vault: {0}")]
    PathEscapesVault(PathBuf),

    #[error("invalid vault-relative path: {0}")]
    InvalidPath(String),
}

pub type Result<T> = std::result::Result<T, IndexError>;
