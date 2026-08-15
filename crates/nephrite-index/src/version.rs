//! Single project version: PostgreSQL-style MAJOR.MINOR.
//!
//! Everything else (index rebuild, crates, release notes) serves `PROJECT_VERSION`.
//!
//! - **Major** change → full vault index rebuild on open
//! - **Minor** change → no rebuild; reconcile only
//!
//! See `docs/versioning.md`.

use std::fmt;
use std::str::FromStr;

use crate::error::{IndexError, Result};

/// The only version that matters. Bump here for releases.
/// Cargo workspace version should match as `MAJOR.MINOR.0`.
pub const PROJECT_VERSION: Version = Version { major: 0, minor: 5 };

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Version {
    pub major: u32,
    pub minor: u32,
}

impl Version {
    pub const fn new(major: u32, minor: u32) -> Self {
        Self { major, minor }
    }

    /// Stored project major ≠ running project major ⇒ rebuild disposable index.
    pub fn requires_rebuild(self, stored: Version) -> bool {
        self.major != stored.major && !self.is_legacy_02_renumbering(stored)
    }

    /// The prototype called the same release line `2.0` before the public
    /// version was corrected to `0.2`. This is a label migration, not an index
    /// epoch change. Keep recognizing it throughout the public 0.x line so a
    /// user can upgrade directly from that prototype to a later minor release.
    pub fn is_legacy_02_renumbering(self, stored: Version) -> bool {
        self.major == 0 && self.minor >= 2 && stored == Version::new(2, 0)
    }
}

impl fmt::Display for Version {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}.{}", self.major, self.minor)
    }
}

impl FromStr for Version {
    type Err = IndexError;

    fn from_str(s: &str) -> Result<Self> {
        let s = s.trim();
        // Accept "0.1" or Cargo-style "0.1.0" (ignore third component).
        let mut parts = s.split('.');
        let major = parts
            .next()
            .ok_or_else(|| IndexError::InvalidPath(format!("bad version: {s}")))?
            .parse::<u32>()
            .map_err(|_| IndexError::InvalidPath(format!("bad version: {s}")))?;
        let minor = parts
            .next()
            .unwrap_or("0")
            .parse::<u32>()
            .map_err(|_| IndexError::InvalidPath(format!("bad version: {s}")))?;
        Ok(Version { major, minor })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn major_mismatch_rebuilds() {
        assert!(Version::new(1, 0).requires_rebuild(Version::new(0, 9)));
        assert!(!Version::new(0, 2).requires_rebuild(Version::new(0, 1)));
        assert!(!Version::new(0, 1).requires_rebuild(Version::new(0, 1)));
        assert!(!Version::new(0, 2).requires_rebuild(Version::new(2, 0)));
        assert!(!Version::new(0, 3).requires_rebuild(Version::new(2, 0)));
        assert!(Version::new(1, 0).requires_rebuild(Version::new(2, 0)));
    }

    #[test]
    fn parse_pg_and_cargo_style() {
        assert_eq!("0.1".parse::<Version>().unwrap(), Version::new(0, 1));
        assert_eq!("0.1.0".parse::<Version>().unwrap(), Version::new(0, 1));
        assert_eq!("14.2".parse::<Version>().unwrap(), Version::new(14, 2));
    }
}
