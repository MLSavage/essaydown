//! `set_coach_key`/`has_coach_key`/`clear_coach_key` (PRD §6.4, §9 non-negotiables): the coach
//! credential lives in the OS credential store via the `keyring` crate, never in `settings.json`
//! and never crossing IPC as a value — `has_coach_key` reports only `{present, backend}`, Rust
//! reads the secret internally (task 5.1's `coach_complete`). `ESSAYDOWN_COACH_KEY` overrides the
//! store for session-only use and is checked first, so a set env var reports `available` even
//! when the OS store itself is locked or unavailable (PRD §4 Secrets row).

#[cfg(not(test))]
const SERVICE: &str = "essaydown";
#[cfg(not(test))]
const USERNAME: &str = "coach";
pub const ENV_VAR: &str = "ESSAYDOWN_COACH_KEY";

/// The OS-credential-store status `has_coach_key` reports (PRD §6.4's own enum). `Deserialize` is
/// for the IPC-log test only (deserializing `has_coach_key`'s own response back), never for a
/// value coming from outside the process.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BackendStatus {
    Available,
    Locked,
    Unavailable,
}

/// `has_coach_key`'s IPC-facing result: a boolean and a status, never the secret.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HasCoachKeyResult {
    pub present: bool,
    pub backend: BackendStatus,
}

/// A credential-store backend. `Ok(None)` from `get` means "no entry" (never set, or cleared) —
/// not a backend failure; `Err` carries the status the caller should report. Real production code
/// uses `SystemKeyring`; `cargo test` uses `InMemoryBackend` (task 2.7's description names this
/// split explicitly), since this container has no real OS credential store to test against.
pub trait CoachKeyBackend: Send + Sync {
    fn set(&self, key: &str) -> Result<(), BackendStatus>;
    fn get(&self) -> Result<Option<String>, BackendStatus>;
    fn clear(&self) -> Result<(), BackendStatus>;
}

/// The real backend: one `keyring` entry, service `essaydown` / username `coach`. Compiled only
/// outside `cargo test` (the managed `CoachKeyState` this crate's `configure()` builds swaps in
/// `InMemoryBackend` under `cfg(test)` instead), so it never sits unused-and-warned in a test
/// build, and `cargo test` never links against a real OS credential store.
#[cfg(not(test))]
pub struct SystemKeyring;

/// `keyring::Error::NoStorageAccess` names a locked/inaccessible store (PRD's "locked"); every
/// other variant (no platform store compiled in, a platform API failure, a malformed stored
/// value, …) is `unavailable` — the two statuses the task's acceptance and §6.4's enum name, read
/// off `keyring-core`'s own `Error` enum (installed at
/// `keyring-core-1.0.0/src/error.rs`) rather than invented here.
#[cfg(not(test))]
fn classify(e: keyring::Error) -> BackendStatus {
    match e {
        keyring::Error::NoStorageAccess(_) => BackendStatus::Locked,
        _ => BackendStatus::Unavailable,
    }
}

#[cfg(not(test))]
impl CoachKeyBackend for SystemKeyring {
    fn set(&self, key: &str) -> Result<(), BackendStatus> {
        let entry = keyring::Entry::new(SERVICE, USERNAME).map_err(classify)?;
        entry.set_password(key).map_err(classify)
    }

    fn get(&self) -> Result<Option<String>, BackendStatus> {
        let entry = keyring::Entry::new(SERVICE, USERNAME).map_err(classify)?;
        match entry.get_password() {
            Ok(secret) => Ok(Some(secret)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(classify(e)),
        }
    }

    fn clear(&self) -> Result<(), BackendStatus> {
        let entry = keyring::Entry::new(SERVICE, USERNAME).map_err(classify)?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(classify(e)),
        }
    }
}

/// The test backend (task 2.7's description: "an in-memory backend under test"): a plain
/// in-process store, so `cargo test` never touches a real OS credential store.
#[cfg(test)]
#[derive(Default)]
pub struct InMemoryBackend(pub std::sync::Mutex<Option<String>>);

#[cfg(test)]
impl CoachKeyBackend for InMemoryBackend {
    fn set(&self, key: &str) -> Result<(), BackendStatus> {
        *self.0.lock().unwrap() = Some(key.to_string());
        Ok(())
    }

    fn get(&self) -> Result<Option<String>, BackendStatus> {
        Ok(self.0.lock().unwrap().clone())
    }

    fn clear(&self) -> Result<(), BackendStatus> {
        *self.0.lock().unwrap() = None;
        Ok(())
    }
}

/// A backend that always fails with a fixed status, for the "OS store is locked or unavailable"
/// branches `InMemoryBackend` cannot reach.
#[cfg(test)]
pub struct FailingBackend(pub BackendStatus);

#[cfg(test)]
impl CoachKeyBackend for FailingBackend {
    fn set(&self, _key: &str) -> Result<(), BackendStatus> {
        Err(self.0)
    }
    fn get(&self) -> Result<Option<String>, BackendStatus> {
        Err(self.0)
    }
    fn clear(&self) -> Result<(), BackendStatus> {
        Err(self.0)
    }
}

/// The managed backend `commands.rs`'s IPC commands call: `SystemKeyring` in production,
/// `InMemoryBackend` under `cargo test` (`lib.rs::configure`, `#[cfg(test)]`-gated).
pub struct CoachKeyState(pub Box<dyn CoachKeyBackend>);

/// `has_coach_key`, parameterized over the backend and the env var's value so both are exercised
/// without ever mutating the real process environment in a test (`ESSAYDOWN_COACH_KEY` wins over
/// the store, checked first so a locked/unavailable store never even needs to be reached).
pub fn has_coach_key_with(backend: &dyn CoachKeyBackend, env_override: Option<&str>) -> HasCoachKeyResult {
    if env_override.is_some_and(|v| !v.is_empty()) {
        return HasCoachKeyResult { present: true, backend: BackendStatus::Available };
    }
    match backend.get() {
        Ok(Some(_)) => HasCoachKeyResult { present: true, backend: BackendStatus::Available },
        Ok(None) => HasCoachKeyResult { present: false, backend: BackendStatus::Available },
        Err(status) => HasCoachKeyResult { present: false, backend: status },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn present_after_set() {
        let backend = InMemoryBackend::default();
        backend.set("sk-secret").unwrap();
        assert_eq!(
            has_coach_key_with(&backend, None),
            HasCoachKeyResult { present: true, backend: BackendStatus::Available }
        );
    }

    #[test]
    fn absent_before_set() {
        let backend = InMemoryBackend::default();
        assert_eq!(
            has_coach_key_with(&backend, None),
            HasCoachKeyResult { present: false, backend: BackendStatus::Available }
        );
    }

    #[test]
    fn absent_after_clear() {
        let backend = InMemoryBackend::default();
        backend.set("sk-secret").unwrap();
        backend.clear().unwrap();
        assert_eq!(
            has_coach_key_with(&backend, None),
            HasCoachKeyResult { present: false, backend: BackendStatus::Available }
        );
    }

    /// "env var wins over the store": set on a backend that would otherwise error still reports
    /// present/available, because the env var is checked first and the backend is never reached.
    #[test]
    fn env_var_wins_over_a_failing_store() {
        let backend = FailingBackend(BackendStatus::Unavailable);
        assert_eq!(
            has_coach_key_with(&backend, Some("sk-from-env")),
            HasCoachKeyResult { present: true, backend: BackendStatus::Available }
        );
    }

    /// An empty env var (unset, or set to "") is not a key: falls through to the store.
    #[test]
    fn empty_env_var_falls_through_to_the_store() {
        let backend = InMemoryBackend::default();
        backend.set("sk-secret").unwrap();
        assert_eq!(
            has_coach_key_with(&backend, Some("")),
            HasCoachKeyResult { present: true, backend: BackendStatus::Available }
        );
    }

    /// "a backend returning an error yields backend:'unavailable'".
    #[test]
    fn unavailable_backend_reports_unavailable() {
        let backend = FailingBackend(BackendStatus::Unavailable);
        assert_eq!(
            has_coach_key_with(&backend, None),
            HasCoachKeyResult { present: false, backend: BackendStatus::Unavailable }
        );
    }

    /// The other status §6.4's enum names: a locked (rather than absent/broken) store.
    #[test]
    fn locked_backend_reports_locked() {
        let backend = FailingBackend(BackendStatus::Locked);
        assert_eq!(
            has_coach_key_with(&backend, None),
            HasCoachKeyResult { present: false, backend: BackendStatus::Locked }
        );
    }

    #[test]
    fn backend_status_serializes_lowercase() {
        assert_eq!(serde_json::to_string(&BackendStatus::Available).unwrap(), "\"available\"");
        assert_eq!(serde_json::to_string(&BackendStatus::Locked).unwrap(), "\"locked\"");
        assert_eq!(serde_json::to_string(&BackendStatus::Unavailable).unwrap(), "\"unavailable\"");
    }
}
