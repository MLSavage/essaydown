//! `get_settings`/`set_settings` (PRD §6.4): raw JSON I/O against `settings.json` in the platform
//! config dir. Rust owns only the bytes; the schema, defaults and corrupt-file fallback are
//! `packages/core`'s `settings.ts` (zod), the same split as `read_sidecar`/`write_sidecar` and
//! `packages/core`'s `sidecar.ts` — this module never parses or validates the contents.

use std::io;
use std::path::Path;

use crate::workspace::atomic_write;

/// Failure modes of `get_settings`/`set_settings`. Not `WorkspaceError`: the settings file is
/// never workspace-relative, so `PathOutsideWorkspace`/`NoWorkspace` do not apply here.
#[derive(Debug)]
pub enum SettingsError {
    /// The platform config dir could not be resolved (PRD §6.4's `get_settings`/`set_settings`
    /// take no path argument, so this is the only path-shaped failure they can have).
    ConfigDirUnavailable,
    Io(io::ErrorKind),
}

impl From<io::Error> for SettingsError {
    fn from(e: io::Error) -> Self {
        SettingsError::Io(e.kind())
    }
}

impl serde::Serialize for SettingsError {
    /// The IPC-facing shape (a bare string), matching `WorkspaceError`'s convention: Rust callers
    /// match on the enum variant, never this string.
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let s = match self {
            SettingsError::ConfigDirUnavailable => "ConfigDirUnavailable".to_string(),
            SettingsError::Io(kind) => format!("Io:{kind:?}"),
        };
        serializer.serialize_str(&s)
    }
}

/// `get_settings`: the raw file contents, or `None` when it does not exist yet (first launch —
/// the frontend's `parseSettings(null)` yields defaults, no warning: a missing file is not a
/// corrupt one).
pub fn read_settings_at(path: &Path) -> Result<Option<String>, SettingsError> {
    match std::fs::read_to_string(path) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// `set_settings`: atomic write, creating the config dir on first write.
pub fn write_settings_at(path: &Path, contents: &str) -> Result<(), SettingsError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    atomic_write(path, contents.as_bytes()).map_err(SettingsError::from)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "essaydown-settings-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn missing_file_reads_as_none() {
        let dir = temp_dir();
        let path = dir.join("settings.json");
        assert!(matches!(read_settings_at(&path), Ok(None)));
    }

    /// The "typewriterScroll persists across relaunch" acceptance's file-level half: a fresh
    /// `read_settings_at` call (standing in for a relaunch, which starts a new process with no
    /// state but the file) sees exactly the bytes the prior `write_settings_at` call wrote.
    /// `settings.test.ts` in `packages/core` covers the other half — that those bytes decode back
    /// to the same `typewriterScroll` value.
    #[test]
    fn write_then_fresh_read_round_trips_bytes() {
        let dir = temp_dir();
        let path = dir.join("settings.json");
        let contents = r#"{"theme":"system","typewriterScroll":true,"coach":{"provider":null,"baseUrl":"","model":""}}"#;
        write_settings_at(&path, contents).unwrap();
        assert_eq!(read_settings_at(&path).unwrap(), Some(contents.to_string()));
    }

    #[test]
    fn write_creates_missing_config_dir() {
        let dir = temp_dir().join("nested").join("config");
        let path = dir.join("settings.json");
        write_settings_at(&path, "{}").unwrap();
        assert_eq!(read_settings_at(&path).unwrap(), Some("{}".to_string()));
    }
}
