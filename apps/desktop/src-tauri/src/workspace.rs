//! Workspace-root path authority and the file operations built on it (PRD §6.4).
//!
//! `resolve_workspace_path` is the single enforcement point for the `WorkspaceRoot` contract:
//! every custom command that takes a path resolves it through this function before touching the
//! filesystem. `WorkspaceError` carries `std::io::ErrorKind` rather than a message so callers (and
//! their tests) match on the kind, never on a string (CLAUDE.md).

use std::ffi::OsString;
use std::io;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

/// Failure modes of the `WorkspaceRoot` contract (PRD §6.4).
#[derive(Debug)]
pub enum WorkspaceError {
    /// `open_folder` has not been called yet, so there is no root to resolve against.
    NoWorkspace,
    /// An absolute path, or the empty path passed to a command that does not accept it.
    InvalidPath,
    /// The resolved path is not strictly beneath the workspace root.
    PathOutsideWorkspace,
    /// Any other I/O failure (e.g. permission denied), carrying the kind rather than a message.
    Io(io::ErrorKind),
}

impl From<io::Error> for WorkspaceError {
    fn from(e: io::Error) -> Self {
        WorkspaceError::Io(e.kind())
    }
}

impl serde::Serialize for WorkspaceError {
    /// The IPC-facing shape (a bare string). Rust callers never match on this string — they match
    /// on the enum variant / `io::ErrorKind` directly — so this is for the frontend only.
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let s = match self {
            WorkspaceError::NoWorkspace => "NoWorkspace".to_string(),
            WorkspaceError::InvalidPath => "InvalidPath".to_string(),
            WorkspaceError::PathOutsideWorkspace => "PathOutsideWorkspace".to_string(),
            WorkspaceError::Io(kind) => format!("Io:{kind:?}"),
        };
        serializer.serialize_str(&s)
    }
}

/// Canonicalises the deepest existing ancestor of `path` and re-appends the non-existent tail
/// components literally, so a path to a not-yet-created file (`write_doc` for a new file) can still
/// be checked for containment against the workspace root.
fn canonicalize_deepest_existing(path: &Path) -> io::Result<PathBuf> {
    let mut tail: Vec<OsString> = Vec::new();
    let mut current = path.to_path_buf();
    loop {
        match current.canonicalize() {
            Ok(mut canon) => {
                while let Some(name) = tail.pop() {
                    canon.push(name);
                }
                return Ok(canon);
            }
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                let name = match current.file_name() {
                    Some(n) => n.to_os_string(),
                    None => return Err(e),
                };
                let parent = current.parent().filter(|p| *p != current);
                match parent {
                    Some(p) => {
                        tail.push(name);
                        current = p.to_path_buf();
                    }
                    None => return Err(e),
                }
            }
            Err(e) => return Err(e),
        }
    }
}

fn is_strictly_beneath(path: &Path, root: &Path) -> bool {
    path != root && path.starts_with(root)
}

/// Resolves `relative` against `root` per the `WorkspaceRoot` contract (PRD §6.4): rejects an
/// absolute path with `InvalidPath` before touching the filesystem; the empty path resolves to
/// `root` itself only when `allow_empty` is true (the `list_tree` / `watch_folder` exception, else
/// `InvalidPath`); otherwise joins to `root`, canonicalises the deepest existing ancestor, and
/// rejects any result not strictly beneath the canonicalised root with `PathOutsideWorkspace`. On a
/// case-insensitive filesystem this containment check is already case-folded, because both sides
/// are the canonicalised (on-disk-cased) form, never the literal request string.
pub fn resolve_workspace_path(
    root: &Path,
    relative: &str,
    allow_empty: bool,
) -> Result<PathBuf, WorkspaceError> {
    if relative.is_empty() {
        return if allow_empty {
            Ok(root.to_path_buf())
        } else {
            Err(WorkspaceError::InvalidPath)
        };
    }

    let candidate = Path::new(relative);
    let has_root_or_prefix = candidate
        .components()
        .next()
        .is_some_and(|c| matches!(c, Component::RootDir | Component::Prefix(_)));
    if candidate.is_absolute() || has_root_or_prefix {
        return Err(WorkspaceError::InvalidPath);
    }

    let joined = root.join(candidate);
    let resolved = canonicalize_deepest_existing(&joined)?;
    let root_canon = canonicalize_deepest_existing(root)?;

    if is_strictly_beneath(&resolved, &root_canon) {
        Ok(resolved)
    } else {
        Err(WorkspaceError::PathOutsideWorkspace)
    }
}

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// A sibling temp path in `target`'s own directory: same directory (so the final rename is same-
/// filesystem and therefore atomic), a name that starts with `.` (never matches list_tree's `.md`
/// filter), unique per process and per call so concurrent writers cannot collide.
fn sibling_temp_path(target: &Path) -> Option<PathBuf> {
    let parent = target.parent()?;
    let base = target.file_name()?.to_string_lossy().into_owned();
    let unique = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    Some(parent.join(format!(".{base}.tmp-{}-{unique}", std::process::id())))
}

/// Writes `contents` to `target` via a temp file in the same directory, preserving `target`'s
/// existing file mode (if any) before the atomic rename. No temp file remains after success or
/// failure: a failed write never created one, and a failed set-permissions/rename is cleaned up.
fn atomic_write(target: &Path, contents: &[u8]) -> Result<(), WorkspaceError> {
    let tmp_path = sibling_temp_path(target).ok_or(WorkspaceError::InvalidPath)?;
    let result = (|| -> io::Result<()> {
        std::fs::write(&tmp_path, contents)?;
        if let Ok(meta) = std::fs::metadata(target) {
            std::fs::set_permissions(&tmp_path, meta.permissions())?;
        }
        std::fs::rename(&tmp_path, target)?;
        Ok(())
    })();
    if let Err(ref e) = result {
        let _ = std::fs::remove_file(&tmp_path);
        let _ = e; // kind is carried out below
    }
    result.map_err(WorkspaceError::from)
}

/// One `.md` file found by `list_tree_at`, workspace-relative with `/` separators regardless of
/// platform, and flagged when it is an undownloaded `.icloud` placeholder for that file.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeEntry {
    pub path: String,
    pub cloud_only: bool,
}

fn to_posix(path: &Path) -> String {
    path.components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join("/")
}

/// Recursive walk collecting every `.md` file under `dir` (relative to `base`) into `out`. Ignores
/// dotfiles and dot-directories (name starts with `.`, so it also skips every temp file
/// `atomic_write` could ever leave behind) and `node_modules` directories; a `<name>.md.icloud`
/// placeholder is reported as `<name>.md` with `cloudOnly: true` rather than ignored.
fn walk_markdown(base: &Path, dir: &Path, out: &mut Vec<TreeEntry>) -> Result<(), WorkspaceError> {
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if name_str.starts_with('.') || name_str == "node_modules" {
            continue;
        }
        let path = entry.path();
        let file_type = entry.file_type()?;
        if file_type.is_dir() {
            walk_markdown(base, &path, out)?;
            continue;
        }
        if !file_type.is_file() {
            continue;
        }
        let (display_name, cloud_only) = if let Some(stem) = name_str.strip_suffix(".icloud") {
            (stem.to_string(), true)
        } else {
            (name_str.into_owned(), false)
        };
        if !display_name.ends_with(".md") {
            continue;
        }
        let rel_dir = dir.strip_prefix(base).unwrap_or(Path::new(""));
        out.push(TreeEntry {
            path: to_posix(&rel_dir.join(&display_name)),
            cloud_only,
        });
    }
    Ok(())
}

/// `list_tree`: every `.md` file under `root`, sorted by path.
pub fn list_tree_at(root: &Path) -> Result<Vec<TreeEntry>, WorkspaceError> {
    let base = resolve_workspace_path(root, "", true)?;
    let mut entries = Vec::new();
    walk_markdown(&base, &base, &mut entries)?;
    entries.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(entries)
}

/// `read_doc`: the UTF-8 contents of the workspace-relative file `relative`.
pub fn read_doc_at(root: &Path, relative: &str) -> Result<String, WorkspaceError> {
    let path = resolve_workspace_path(root, relative, false)?;
    Ok(std::fs::read_to_string(path)?)
}

/// `write_doc`: temp file + atomic rename, preserving the target's existing mode.
pub fn write_doc_at(root: &Path, relative: &str, contents: &str) -> Result<(), WorkspaceError> {
    let path = resolve_workspace_path(root, relative, false)?;
    atomic_write(&path, contents.as_bytes())
}

/// `read_sidecar`: `None` when the sidecar file does not exist (the sidecar is optional, PRD §6.2),
/// any other read failure is propagated.
pub fn read_sidecar_at(root: &Path, relative: &str) -> Result<Option<String>, WorkspaceError> {
    let path = resolve_workspace_path(root, relative, false)?;
    match std::fs::read_to_string(&path) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// `write_sidecar`: same atomic-write contract as `write_doc`.
pub fn write_sidecar_at(root: &Path, relative: &str, contents: &str) -> Result<(), WorkspaceError> {
    let path = resolve_workspace_path(root, relative, false)?;
    atomic_write(&path, contents.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64 as TestCounter, Ordering as TestOrdering};

    static SCRATCH_COUNTER: TestCounter = TestCounter::new(0);

    /// A fresh empty directory under the OS temp dir, unique per call (pid + counter), so parallel
    /// `cargo test` threads never collide.
    fn scratch_dir() -> PathBuf {
        let n = SCRATCH_COUNTER.fetch_add(1, TestOrdering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "essaydown-workspace-test-{}-{n}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir.canonicalize().unwrap()
    }

    // --- resolve_workspace_path: the §6.4 path suite ---

    #[test]
    fn relative_inside_is_ok() {
        let root = scratch_dir();
        std::fs::write(root.join("a.md"), "x").unwrap();
        let resolved = resolve_workspace_path(&root, "a.md", false).unwrap();
        assert_eq!(resolved, root.join("a.md"));
    }

    #[test]
    fn relative_inside_nested_not_yet_existing_is_ok() {
        let root = scratch_dir();
        std::fs::create_dir(root.join("sub")).unwrap();
        let resolved = resolve_workspace_path(&root, "sub/new.md", false).unwrap();
        assert_eq!(resolved, root.join("sub").join("new.md"));
    }

    #[test]
    fn dotdot_escape_is_path_outside_workspace() {
        let root = scratch_dir();
        std::fs::create_dir(root.join("inside")).unwrap();
        let err = resolve_workspace_path(&root.join("inside"), "../outside.md", false).unwrap_err();
        assert!(matches!(err, WorkspaceError::PathOutsideWorkspace));
    }

    #[test]
    fn symlink_out_is_path_outside_workspace() {
        let root = scratch_dir();
        let outside = scratch_dir();
        std::fs::write(outside.join("secret.md"), "x").unwrap();
        std::os::unix::fs::symlink(&outside, root.join("link")).unwrap();
        let err = resolve_workspace_path(&root, "link/secret.md", false).unwrap_err();
        assert!(matches!(err, WorkspaceError::PathOutsideWorkspace));
    }

    #[test]
    fn parent_symlink_with_nonexistent_target_is_path_outside_workspace() {
        let root = scratch_dir();
        let outside = scratch_dir();
        std::os::unix::fs::symlink(&outside, root.join("link")).unwrap();
        // "new.md" under the symlinked-out parent does not exist yet.
        let err = resolve_workspace_path(&root, "link/new.md", false).unwrap_err();
        assert!(matches!(err, WorkspaceError::PathOutsideWorkspace));
    }

    #[test]
    fn absolute_path_is_invalid_path() {
        let root = scratch_dir();
        let outside = scratch_dir();
        let absolute = outside.join("x.md");
        let err =
            resolve_workspace_path(&root, absolute.to_str().unwrap(), false).unwrap_err();
        assert!(matches!(err, WorkspaceError::InvalidPath));
    }

    #[test]
    fn absolute_path_inside_workspace_is_still_invalid_path() {
        let root = scratch_dir();
        std::fs::write(root.join("a.md"), "x").unwrap();
        let inside_absolute = root.join("a.md");
        let err =
            resolve_workspace_path(&root, inside_absolute.to_str().unwrap(), false).unwrap_err();
        assert!(matches!(err, WorkspaceError::InvalidPath));
    }

    #[test]
    fn empty_path_is_ok_for_list_tree_and_watch_folder() {
        let root = scratch_dir();
        let resolved = resolve_workspace_path(&root, "", true).unwrap();
        assert_eq!(resolved, root);
    }

    #[test]
    fn empty_path_is_invalid_path_for_every_other_command() {
        let root = scratch_dir();
        let err = resolve_workspace_path(&root, "", false).unwrap_err();
        assert!(matches!(err, WorkspaceError::InvalidPath));
    }

    #[test]
    fn export_style_output_path_outside_workspace_is_rejected() {
        // Export (Phase 4) is not implemented yet, but it will resolve its output path through
        // this same function; a relative path that escapes through a symlink must be rejected
        // exactly like any other command's path, named here per the §6.4 acceptance clause.
        let root = scratch_dir();
        let outside = scratch_dir();
        std::os::unix::fs::symlink(&outside, root.join("export-link")).unwrap();
        let err =
            resolve_workspace_path(&root, "export-link/out.pdf", false).unwrap_err();
        assert!(matches!(err, WorkspaceError::PathOutsideWorkspace));
    }

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    #[test]
    fn case_folded_escape_is_path_outside_workspace() {
        // Only meaningful on a case-insensitive filesystem (macOS default, Windows); ext4 in this
        // container is case-sensitive, so this case cannot be exercised here (recorded in the
        // journal) and is gated to the two OSes whose default filesystem folds case. The request
        // names the real outside directory with different case than its on-disk name ("OUTSIDE-"
        // for a directory actually created as "Outside-<n>"); the OS's own case folding still
        // finds it, and the containment check — comparing two canonicalised, OS-cased paths — must
        // still reject it, exactly as a same-case `..` escape would (`dotdot_escape_...` above).
        let root = scratch_dir();
        let outside = scratch_dir();
        let outside_name = outside.file_name().unwrap().to_str().unwrap();
        let candidate = format!(
            "../{}/{}",
            outside_name.to_uppercase(),
            "probe.md"
        );
        let err = resolve_workspace_path(&root, &candidate, false).unwrap_err();
        assert!(matches!(err, WorkspaceError::PathOutsideWorkspace));
    }

    #[cfg(windows)]
    #[test]
    fn windows_junction_escape_is_path_outside_workspace() {
        let root = scratch_dir();
        let outside = scratch_dir();
        std::os::windows::fs::symlink_dir(&outside, root.join("junction")).unwrap();
        let err = resolve_workspace_path(&root, "junction/x.md", false).unwrap_err();
        assert!(matches!(err, WorkspaceError::PathOutsideWorkspace));
    }

    // --- write_doc / atomic_write ---

    #[test]
    fn write_doc_creates_no_temp_file_on_success() {
        let root = scratch_dir();
        write_doc_at(&root, "a.md", "hello").unwrap();
        assert_eq!(std::fs::read_to_string(root.join("a.md")).unwrap(), "hello");
        let leftovers: Vec<_> = std::fs::read_dir(&root)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().starts_with('.'))
            .collect();
        assert!(leftovers.is_empty(), "leftover temp files: {leftovers:?}");
    }

    #[test]
    fn write_doc_preserves_existing_mode() {
        use std::os::unix::fs::PermissionsExt;
        let root = scratch_dir();
        let target = root.join("a.md");
        std::fs::write(&target, "old").unwrap();
        std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o640)).unwrap();
        write_doc_at(&root, "a.md", "new").unwrap();
        let mode = std::fs::metadata(&target).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o640);
    }

    #[cfg(unix)]
    #[test]
    fn write_doc_to_permission_denied_dir_returns_permission_denied() {
        use std::os::unix::fs::PermissionsExt;
        let root = scratch_dir();
        let denied = root.join("denied");
        std::fs::create_dir(&denied).unwrap();
        std::fs::set_permissions(&denied, std::fs::Permissions::from_mode(0o555)).unwrap();

        let result = write_doc_at(&root, "denied/a.md", "x");

        // Restore write access before the temp-dir cleanup removes `denied`, whatever the outcome.
        std::fs::set_permissions(&denied, std::fs::Permissions::from_mode(0o755)).unwrap();

        let err = result.unwrap_err();
        assert!(matches!(err, WorkspaceError::Io(io::ErrorKind::PermissionDenied)));
        let leftovers: Vec<_> = std::fs::read_dir(&denied)
            .unwrap()
            .filter_map(|e| e.ok())
            .collect();
        assert!(leftovers.is_empty(), "leftover temp files: {leftovers:?}");
    }

    /// Denies the current user write access to a fresh temp directory via `icacls` (no new Cargo
    /// dependency: Windows ACLs are set by shelling out to the built-in tool, matching the write-
    /// permission test's Unix `chmod` twin above; CI's windows runner is the only place this runs).
    #[cfg(windows)]
    fn deny_write_access(dir: &Path) {
        let user = std::env::var("USERNAME").unwrap_or_else(|_| "Everyone".to_string());
        let status = std::process::Command::new("icacls")
            .arg(dir)
            .arg("/deny")
            .arg(format!("{user}:(W,AD,WD)"))
            .status()
            .expect("failed to run icacls");
        assert!(status.success(), "icacls /deny failed");
    }

    #[cfg(windows)]
    fn allow_write_access(dir: &Path) {
        let user = std::env::var("USERNAME").unwrap_or_else(|_| "Everyone".to_string());
        let _ = std::process::Command::new("icacls")
            .arg(dir)
            .arg("/remove:d")
            .arg(user)
            .status();
    }

    #[cfg(windows)]
    #[test]
    fn write_doc_to_acl_denied_dir_returns_permission_denied() {
        let root = scratch_dir();
        let denied = root.join("denied");
        std::fs::create_dir(&denied).unwrap();
        deny_write_access(&denied);

        let result = write_doc_at(&root, "denied/a.md", "x");
        allow_write_access(&denied);

        let err = result.unwrap_err();
        assert!(matches!(err, WorkspaceError::Io(io::ErrorKind::PermissionDenied)));
        let leftovers: Vec<_> = std::fs::read_dir(&denied)
            .unwrap()
            .filter_map(|e| e.ok())
            .collect();
        assert!(leftovers.is_empty(), "leftover temp files: {leftovers:?}");
    }

    // --- read/write_sidecar ---

    #[test]
    fn read_sidecar_missing_is_none() {
        let root = scratch_dir();
        assert_eq!(read_sidecar_at(&root, "a.essaydown.json").unwrap(), None);
    }

    #[test]
    fn write_then_read_sidecar_round_trips() {
        let root = scratch_dir();
        write_sidecar_at(&root, "a.essaydown.json", "{\"version\":1}").unwrap();
        assert_eq!(
            read_sidecar_at(&root, "a.essaydown.json").unwrap(),
            Some("{\"version\":1}".to_string())
        );
    }

    // --- list_tree ---

    #[test]
    fn list_tree_ignores_dotfiles_node_modules_and_reports_icloud_placeholders() {
        let root = scratch_dir();
        std::fs::write(root.join("keep.md"), "x").unwrap();
        std::fs::write(root.join(".hidden.md"), "x").unwrap();
        std::fs::create_dir(root.join(".git")).unwrap();
        std::fs::write(root.join(".git").join("also.md"), "x").unwrap();
        std::fs::create_dir(root.join("node_modules")).unwrap();
        std::fs::write(root.join("node_modules").join("pkg.md"), "x").unwrap();
        std::fs::write(root.join("cloud.md.icloud"), "").unwrap();
        std::fs::write(root.join("not-markdown.txt"), "x").unwrap();

        let entries = list_tree_at(&root).unwrap();
        assert_eq!(
            entries,
            vec![
                TreeEntry { path: "cloud.md".to_string(), cloud_only: true },
                TreeEntry { path: "keep.md".to_string(), cloud_only: false },
            ]
        );
    }

    #[test]
    fn list_tree_is_recursive_and_sorted_by_path() {
        let root = scratch_dir();
        std::fs::create_dir(root.join("sub")).unwrap();
        std::fs::write(root.join("z.md"), "x").unwrap();
        std::fs::write(root.join("sub").join("a.md"), "x").unwrap();

        let entries = list_tree_at(&root).unwrap();
        let paths: Vec<_> = entries.iter().map(|e| e.path.as_str()).collect();
        assert_eq!(paths, vec!["sub/a.md", "z.md"]);
    }

    #[test]
    fn list_tree_on_fixtures_markdown_matches_the_disk_count() {
        let fixtures = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../fixtures/markdown")
            .canonicalize()
            .expect("fixtures/markdown must exist");

        fn count_md(dir: &Path) -> usize {
            let mut n = 0;
            for entry in std::fs::read_dir(dir).unwrap() {
                let entry = entry.unwrap();
                let name = entry.file_name().to_string_lossy().into_owned();
                if name.starts_with('.') || name == "node_modules" {
                    continue;
                }
                let path = entry.path();
                if path.is_dir() {
                    n += count_md(&path);
                } else if name.ends_with(".md") {
                    n += 1;
                }
            }
            n
        }

        let expected = count_md(&fixtures);
        let entries = list_tree_at(&fixtures).unwrap();
        assert_eq!(entries.len(), expected);
        let mut sorted = entries.clone();
        sorted.sort_by(|a, b| a.path.cmp(&b.path));
        assert_eq!(entries, sorted);
    }
}
