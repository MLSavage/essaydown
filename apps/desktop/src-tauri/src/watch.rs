//! `watch_folder` (PRD §6.4: notify → event `fs:changed`), task 2.5.
//!
//! The watcher reports *which document changed*, never what changed or whether the change is
//! finished: the frontend reads the file itself and owns every decision about it (its own write
//! echoing back, a sync tool's truncate-then-rewrite, a dirty buffer). So this module is two pure
//! pieces cargo tests exercise directly — which event kinds count, and which paths are documents —
//! and one function that wires them onto a `notify` watcher.

use std::path::{Component, Path, PathBuf};

use notify::event::{EventKind, ModifyKind};
use notify::{RecommendedWatcher, RecursiveMode, Watcher};

use crate::workspace::{resolve_workspace_path, WorkspaceError};

/// The event name the frontend listens on (PRD §6.4).
pub const FS_CHANGED: &str = "fs:changed";

/// The `fs:changed` payload: one workspace-relative, `/`-separated document path.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct FsChanged {
    pub path: String,
}

/// Whether an event kind can mean the bytes of a file changed. Access events are excluded because
/// the frontend answers every `fs:changed` with a `read_doc`, and a read that reported itself would
/// be a loop; metadata-only modifications (mode, times) are excluded because they change no bytes.
pub fn is_content_event(kind: &EventKind) -> bool {
    match kind {
        EventKind::Access(_) => false,
        EventKind::Modify(ModifyKind::Metadata(_)) => false,
        EventKind::Any
        | EventKind::Create(_)
        | EventKind::Modify(_)
        | EventKind::Remove(_)
        | EventKind::Other => true,
    }
}

/// The documents among an event's paths: `.md` files strictly beneath `root`, relative to it with
/// `/` separators (`TreeEntry.path`'s shape, so the frontend compares them to its open path as
/// strings), skipping any path with a dot-component — `write_doc`'s own `.<name>.tmp-…` sibling,
/// `.git`, `.stfolder` — which `list_tree` never lists either. Order follows `paths`, duplicates
/// removed.
pub fn changed_documents(root: &Path, paths: &[PathBuf]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for path in paths {
        let Ok(relative) = path.strip_prefix(root) else { continue };
        let mut parts: Vec<String> = Vec::new();
        let mut plain = true;
        for component in relative.components() {
            match component {
                Component::Normal(name) => {
                    let name = name.to_string_lossy();
                    if name.starts_with('.') {
                        plain = false;
                        break;
                    }
                    parts.push(name.into_owned());
                }
                _ => {
                    plain = false;
                    break;
                }
            }
        }
        let is_markdown = parts.last().is_some_and(|name| name.ends_with(".md"));
        if !plain || !is_markdown {
            continue;
        }
        let joined = parts.join("/");
        if !out.contains(&joined) {
            out.push(joined);
        }
    }
    out
}

/// Starts a recursive watcher on `relative` (the empty path is the root itself, the one command
/// besides `list_tree` that accepts it — PRD §6.4), calling `sink` once per changed document per
/// content event. The watcher stops when the returned value is dropped.
pub fn watch_folder_at<F>(root: &Path, relative: &str, sink: F) -> Result<RecommendedWatcher, WorkspaceError>
where
    F: Fn(String) + Send + 'static,
{
    let dir = resolve_workspace_path(root, relative, true)?;
    let base = root.canonicalize()?;
    let mut watcher = notify::recommended_watcher(move |result: notify::Result<notify::Event>| {
        // A watcher error (an overflowed inotify queue, a removed watch) carries no path to report;
        // the next content event still arrives, so dropping it loses no document.
        let Ok(event) = result else { return };
        if !is_content_event(&event.kind) {
            return;
        }
        for path in changed_documents(&base, &event.paths) {
            sink(path);
        }
    })
    .map_err(notify_error)?;
    watcher.watch(&dir, RecursiveMode::Recursive).map_err(notify_error)?;
    Ok(watcher)
}

fn notify_error(error: notify::Error) -> WorkspaceError {
    match error.kind {
        notify::ErrorKind::Io(e) => WorkspaceError::Io(e.kind()),
        notify::ErrorKind::PathNotFound => WorkspaceError::Io(std::io::ErrorKind::NotFound),
        _ => WorkspaceError::Io(std::io::ErrorKind::Other),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use notify::event::{AccessKind, CreateKind, DataChange, MetadataKind, RemoveKind, RenameMode};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::mpsc;
    use std::time::Duration;

    static SCRATCH: AtomicU64 = AtomicU64::new(0);

    fn scratch_dir() -> PathBuf {
        let n = SCRATCH.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("essaydown-watch-test-{}-{n}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir.canonicalize().unwrap()
    }

    #[test]
    fn content_events_count_and_access_and_metadata_do_not() {
        assert!(is_content_event(&EventKind::Create(CreateKind::File)));
        assert!(is_content_event(&EventKind::Modify(ModifyKind::Data(DataChange::Any))));
        assert!(is_content_event(&EventKind::Modify(ModifyKind::Name(RenameMode::To))));
        assert!(is_content_event(&EventKind::Remove(RemoveKind::File)));
        assert!(is_content_event(&EventKind::Any));
        assert!(!is_content_event(&EventKind::Access(AccessKind::Read)));
        assert!(!is_content_event(&EventKind::Modify(ModifyKind::Metadata(MetadataKind::Permissions))));
    }

    #[test]
    fn changed_documents_keeps_markdown_beneath_root_relative_with_slashes() {
        let root = PathBuf::from("/w");
        let paths = vec![
            root.join("a.md"),
            root.join("sub").join("b.md"),
            root.join("a.md"),
            root.join("notes.txt"),
            root.join("a.essaydown.json"),
            root.join(".a.md.tmp-1-0"),
            root.join(".stfolder").join("c.md"),
            root.join("sub").join(".hidden.md"),
            PathBuf::from("/elsewhere/d.md"),
            root.clone(),
        ];
        assert_eq!(changed_documents(&root, &paths), vec!["a.md".to_string(), "sub/b.md".to_string()]);
    }

    #[test]
    fn changed_documents_of_no_paths_is_empty() {
        assert!(changed_documents(Path::new("/w"), &[]).is_empty());
    }

    // --- the §6.4 contract: `watch_folder` takes the empty path, and nothing outside the root ---

    #[test]
    fn watch_folder_accepts_the_root_itself() {
        let root = scratch_dir();
        assert!(watch_folder_at(&root, "", |_| {}).is_ok());
    }

    #[test]
    fn watch_folder_rejects_an_absolute_path() {
        let root = scratch_dir();
        let err = watch_folder_at(&root, root.to_str().unwrap(), |_| {}).unwrap_err();
        assert!(matches!(err, WorkspaceError::InvalidPath));
    }

    #[test]
    fn watch_folder_rejects_a_dotdot_escape() {
        let root = scratch_dir();
        std::fs::create_dir(root.join("inside")).unwrap();
        let err = watch_folder_at(&root.join("inside"), "..", |_| {}).unwrap_err();
        assert!(matches!(err, WorkspaceError::PathOutsideWorkspace));
    }

    #[cfg(unix)]
    #[test]
    fn watch_folder_rejects_a_symlink_out() {
        let root = scratch_dir();
        let outside = scratch_dir();
        std::os::unix::fs::symlink(&outside, root.join("link")).unwrap();
        let err = watch_folder_at(&root, "link", |_| {}).unwrap_err();
        assert!(matches!(err, WorkspaceError::PathOutsideWorkspace));
    }

    fn drain(rx: &mpsc::Receiver<String>, quiet: Duration) -> Vec<String> {
        let mut seen = Vec::new();
        while let Ok(path) = rx.recv_timeout(quiet) {
            seen.push(path);
        }
        seen
    }

    /// The live watcher: an external write to a nested document is reported by its relative path,
    /// and a plain read of it afterwards reports nothing — the frontend reads on every report, so a
    /// read that reported itself would never go quiet.
    #[test]
    fn a_write_is_reported_and_a_read_is_not() {
        let root = scratch_dir();
        std::fs::create_dir(root.join("sub")).unwrap();
        std::fs::write(root.join("sub").join("b.md"), "old\n").unwrap();
        let (tx, rx) = mpsc::channel();
        let _watcher = watch_folder_at(&root, "", move |path| {
            let _ = tx.send(path);
        })
        .unwrap();

        std::fs::write(root.join("sub").join("b.md"), "new\n").unwrap();
        let seen = drain(&rx, Duration::from_millis(1500));
        assert!(seen.iter().any(|p| p == "sub/b.md"), "no report for sub/b.md: {seen:?}");
        assert!(seen.iter().all(|p| p == "sub/b.md"), "unexpected reports: {seen:?}");

        assert_eq!(std::fs::read_to_string(root.join("sub").join("b.md")).unwrap(), "new\n");
        assert!(drain(&rx, Duration::from_millis(500)).is_empty(), "a read was reported");
    }

    /// `write_doc`'s temp-file-then-rename reaches the watcher as the target's name only, never the
    /// dot-named temp sibling.
    #[test]
    fn an_atomic_write_is_reported_by_the_target_name_only() {
        let root = scratch_dir();
        std::fs::write(root.join("a.md"), "old\n").unwrap();
        let (tx, rx) = mpsc::channel();
        let _watcher = watch_folder_at(&root, "", move |path| {
            let _ = tx.send(path);
        })
        .unwrap();

        crate::workspace::write_doc_at(&root, "a.md", "new\n").unwrap();
        let seen = drain(&rx, Duration::from_millis(1500));
        assert!(seen.iter().any(|p| p == "a.md"), "no report for a.md: {seen:?}");
        assert!(seen.iter().all(|p| p == "a.md"), "unexpected reports: {seen:?}");
    }
}
