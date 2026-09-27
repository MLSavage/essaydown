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
/// Plain `io::Result` (not `WorkspaceError`) because `settings.rs` writes to the platform config
/// dir, which is never a workspace-relative path and so never carries a `WorkspaceError`.
pub(crate) fn atomic_write(target: &Path, contents: &[u8]) -> io::Result<()> {
    let tmp_path = sibling_temp_path(target)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "target has no parent directory"))?;
    let result = (|| -> io::Result<()> {
        std::fs::write(&tmp_path, contents)?;
        if let Ok(meta) = std::fs::metadata(target) {
            std::fs::set_permissions(&tmp_path, meta.permissions())?;
        }
        std::fs::rename(&tmp_path, target)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp_path);
    }
    result
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
    atomic_write(&path, contents.as_bytes()).map_err(WorkspaceError::from)
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
    atomic_write(&path, contents.as_bytes()).map_err(WorkspaceError::from)
}

/// The document's file stem (`a.md` -> `a`), the name `new_file`/`rename_file`/`delete_to_trash`
/// derive the sidecar and assets-directory names from.
fn file_stem_of(relative: &str) -> Option<String> {
    Path::new(relative)
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
}

/// The workspace-relative sidecar path for a document: `<stem>.essaydown.json` in the document's own
/// directory (PRD §6 Identifiers).
fn sidecar_relative_for(relative: &str) -> Option<String> {
    let path = Path::new(relative);
    let stem = file_stem_of(relative)?;
    let dir = path.parent().unwrap_or(Path::new(""));
    Some(to_posix(&dir.join(format!("{stem}.essaydown.json"))))
}

/// The workspace-relative assets directory for a document: `assets/<stem>` in the document's own
/// directory, matching how the rendered view resolves an image's relative `src` against `docDir`
/// (PRD §6.4).
fn assets_relative_for(relative: &str) -> Option<String> {
    let path = Path::new(relative);
    let stem = file_stem_of(relative)?;
    let dir = path.parent().unwrap_or(Path::new(""));
    Some(to_posix(&dir.join("assets").join(stem)))
}

/// `new_file`: the next unused `Untitled-N.md` (N starts at 1, computed from the highest existing
/// `Untitled-N.md` at the workspace root, never reused after a gap) with `# Untitled-N` as its only
/// content. Returns the new file's workspace-relative path.
pub fn new_file_at(root: &Path) -> Result<String, WorkspaceError> {
    let base = resolve_workspace_path(root, "", true)?;
    let mut max_n: u64 = 0;
    for entry in std::fs::read_dir(&base)? {
        let entry = entry?;
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if let Some(rest) = name_str.strip_prefix("Untitled-") {
            if let Some(digits) = rest.strip_suffix(".md") {
                if let Ok(n) = digits.parse::<u64>() {
                    max_n = max_n.max(n);
                }
            }
        }
    }
    let n = max_n + 1;
    let relative = format!("Untitled-{n}.md");
    let path = resolve_workspace_path(root, &relative, false)?;
    atomic_write(&path, format!("# Untitled-{n}\n").as_bytes())?;
    Ok(relative)
}

/// `rename_file`: renames the document, its sidecar (if present) and its `assets/<stem>` directory
/// (if present) together, then rewrites every relative image URL in the moved document that points
/// into `assets/<oldstem>/` to `assets/<newstem>/`. The target document already existing is
/// `AlreadyExists` and changes nothing; a failure renaming the sidecar or the assets directory rolls
/// back everything renamed so far, so a caller never observes a half-renamed document.
pub fn rename_file_at(
    root: &Path,
    old_relative: &str,
    new_relative: &str,
) -> Result<(), WorkspaceError> {
    let old_doc = resolve_workspace_path(root, old_relative, false)?;
    let new_doc = resolve_workspace_path(root, new_relative, false)?;

    if new_doc.exists() {
        return Err(WorkspaceError::Io(io::ErrorKind::AlreadyExists));
    }

    let old_stem = file_stem_of(old_relative).ok_or(WorkspaceError::InvalidPath)?;
    let new_stem = file_stem_of(new_relative).ok_or(WorkspaceError::InvalidPath)?;

    let old_sidecar_rel = sidecar_relative_for(old_relative).ok_or(WorkspaceError::InvalidPath)?;
    let new_sidecar_rel = sidecar_relative_for(new_relative).ok_or(WorkspaceError::InvalidPath)?;
    let old_assets_rel = assets_relative_for(old_relative).ok_or(WorkspaceError::InvalidPath)?;
    let new_assets_rel = assets_relative_for(new_relative).ok_or(WorkspaceError::InvalidPath)?;

    let old_sidecar = resolve_workspace_path(root, &old_sidecar_rel, false)?;
    let new_sidecar = resolve_workspace_path(root, &new_sidecar_rel, false)?;
    let old_assets = resolve_workspace_path(root, &old_assets_rel, false)?;
    let new_assets = resolve_workspace_path(root, &new_assets_rel, false)?;

    std::fs::rename(&old_doc, &new_doc)?;

    let sidecar_existed = old_sidecar.exists();
    if sidecar_existed {
        if let Err(e) = std::fs::rename(&old_sidecar, &new_sidecar) {
            let _ = std::fs::rename(&new_doc, &old_doc);
            return Err(e.into());
        }
    }

    let assets_existed = old_assets.exists();
    if assets_existed {
        if let Err(e) = std::fs::rename(&old_assets, &new_assets) {
            if sidecar_existed {
                let _ = std::fs::rename(&new_sidecar, &old_sidecar);
            }
            let _ = std::fs::rename(&new_doc, &old_doc);
            return Err(e.into());
        }
    }

    let content = std::fs::read_to_string(&new_doc)?;
    let old_needle = format!("assets/{old_stem}/");
    if content.contains(&old_needle) {
        let rewritten = content.replace(&old_needle, &format!("assets/{new_stem}/"));
        atomic_write(&new_doc, rewritten.as_bytes())?;
    }

    Ok(())
}

/// Real deletions route through the OS trash (the `trash` crate, PRD §4); a test build injects a
/// recording fake instead so `cargo test` never touches a real trash can.
pub trait TrashBackend {
    fn trash(&self, path: &Path) -> Result<(), WorkspaceError>;
}

/// The production `TrashBackend`.
pub struct SystemTrash;

impl TrashBackend for SystemTrash {
    fn trash(&self, path: &Path) -> Result<(), WorkspaceError> {
        trash::delete(path).map_err(|_| WorkspaceError::Io(io::ErrorKind::Other))
    }
}

/// `delete_to_trash`: trashes the document, its sidecar and its `assets/<stem>` directory together,
/// calling `backend` once per item that exists on disk — a missing sidecar or assets directory is
/// skipped, never trashed.
pub fn delete_to_trash_at<T: TrashBackend>(
    root: &Path,
    relative: &str,
    backend: &T,
) -> Result<(), WorkspaceError> {
    let doc = resolve_workspace_path(root, relative, false)?;
    let sidecar_rel = sidecar_relative_for(relative).ok_or(WorkspaceError::InvalidPath)?;
    let assets_rel = assets_relative_for(relative).ok_or(WorkspaceError::InvalidPath)?;
    let sidecar = resolve_workspace_path(root, &sidecar_rel, false)?;
    let assets = resolve_workspace_path(root, &assets_rel, false)?;

    for path in [doc, sidecar, assets] {
        if path.exists() {
            backend.trash(&path)?;
        }
    }
    Ok(())
}

/// `reveal_in_folder`: resolves `relative` through the `WorkspaceRoot` contract, the same as every
/// other path-taking command.
pub fn resolve_for_reveal(root: &Path, relative: &str) -> Result<PathBuf, WorkspaceError> {
    resolve_workspace_path(root, relative, false)
}

static IMAGE_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Six base36 characters, distinct for every call in this process even within the same
/// nanosecond-resolution tick: `nanos` is mixed with a strictly increasing per-process counter
/// (never a repeated value) through a splitmix64-style hash, so two pastes cannot land on the same
/// counter and therefore cannot land on the same suffix.
fn random_base36(len: usize, nanos: u64) -> String {
    let counter = IMAGE_COUNTER.fetch_add(1, Ordering::Relaxed);
    let mut z = nanos ^ counter.wrapping_mul(0x9E37_79B9_7F4A_7C15) ^ (std::process::id() as u64);
    z = z.wrapping_add(0x9E37_79B9_7F4A_7C15);
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^= z >> 31;

    const DIGITS: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut out = Vec::with_capacity(len);
    let mut v = z;
    for _ in 0..len {
        out.push(DIGITS[(v % 36) as usize]);
        v /= 36;
    }
    String::from_utf8(out).unwrap()
}

/// Howard Hinnant's `civil_from_days` (public-domain "chrono-Compatible Low-Level Date Algorithms"),
/// UTC, no external crate: seconds since the Unix epoch to (year, month, day, hour, minute, second).
/// No new dependency (PRD §4's Rust crates row does not list a date/time crate).
fn civil_from_unix(secs: i64) -> (i64, u32, u32, u32, u32, u32) {
    let days = secs.div_euclid(86400);
    let rem = secs.rem_euclid(86400);
    let hour = (rem / 3600) as u32;
    let minute = ((rem % 3600) / 60) as u32;
    let second = (rem % 60) as u32;

    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y = if m <= 2 { y + 1 } else { y };
    (y, m, d, hour, minute, second)
}

/// `<yyyyMMdd-HHmmss>-<6 random base36>.<ext>` (PRD §6.4). `extension` is checked to be 1–10 ASCII
/// alphanumeric characters so it can never inject a path separator or a `..` segment into the
/// filename it becomes the suffix of.
fn unique_image_filename(extension: &str) -> Result<String, WorkspaceError> {
    if extension.is_empty() || extension.len() > 10 || !extension.bytes().all(|b| b.is_ascii_alphanumeric()) {
        return Err(WorkspaceError::InvalidPath);
    }
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| WorkspaceError::Io(io::ErrorKind::Other))?;
    let (y, mo, d, h, mi, s) = civil_from_unix(now.as_secs() as i64);
    let stamp = format!("{y:04}{mo:02}{d:02}-{h:02}{mi:02}{s:02}");
    let suffix = random_base36(6, now.as_nanos() as u64);
    Ok(format!("{stamp}-{suffix}.{}", extension.to_ascii_lowercase()))
}

/// `save_image`: writes `bytes` into the document's own `assets/<stem>` directory (created if
/// absent) under a fresh unique filename, and returns the *document-directory-relative* fragment
/// `assets/<stem>/<file>` (PRD §6.4) — not workspace-relative — because that is exactly the string
/// the caller inserts as `![](…)`, which the rendered view resolves against `docDir`, not `root`.
pub fn save_image_at(
    root: &Path,
    doc_relative: &str,
    bytes: &[u8],
    extension: &str,
) -> Result<String, WorkspaceError> {
    let filename = unique_image_filename(extension)?;
    let stem = file_stem_of(doc_relative).ok_or(WorkspaceError::InvalidPath)?;
    let assets_rel = assets_relative_for(doc_relative).ok_or(WorkspaceError::InvalidPath)?;
    let assets_dir = resolve_workspace_path(root, &assets_rel, false)?;
    std::fs::create_dir_all(&assets_dir)?;
    std::fs::write(assets_dir.join(&filename), bytes)?;
    Ok(format!("assets/{stem}/{filename}"))
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

    #[cfg(unix)]
    #[test]
    fn symlink_out_is_path_outside_workspace() {
        let root = scratch_dir();
        let outside = scratch_dir();
        std::fs::write(outside.join("secret.md"), "x").unwrap();
        std::os::unix::fs::symlink(&outside, root.join("link")).unwrap();
        let err = resolve_workspace_path(&root, "link/secret.md", false).unwrap_err();
        assert!(matches!(err, WorkspaceError::PathOutsideWorkspace));
    }

    #[cfg(unix)]
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

    #[cfg(unix)]
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

    #[cfg(unix)]
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

    // --- new_file ---

    #[test]
    fn new_file_creates_untitled_1_with_matching_heading() {
        let root = scratch_dir();
        let relative = new_file_at(&root).unwrap();
        assert_eq!(relative, "Untitled-1.md");
        assert_eq!(
            std::fs::read_to_string(root.join("Untitled-1.md")).unwrap(),
            "# Untitled-1\n"
        );
    }

    #[test]
    fn new_file_numbers_past_the_highest_existing_untitled_ignoring_gaps() {
        let root = scratch_dir();
        std::fs::write(root.join("Untitled-1.md"), "# Untitled-1\n").unwrap();
        std::fs::write(root.join("Untitled-5.md"), "# Untitled-5\n").unwrap();
        let relative = new_file_at(&root).unwrap();
        assert_eq!(relative, "Untitled-6.md");
    }

    // --- rename_file ---

    #[test]
    fn rename_moves_doc_sidecar_and_assets_and_rewrites_image_urls() {
        let root = scratch_dir();
        std::fs::write(root.join("a.md"), "See ![x](assets/a/x.png) and ![y](assets/a/y.png).")
            .unwrap();
        std::fs::write(root.join("a.essaydown.json"), "{\"version\":1}").unwrap();
        std::fs::create_dir_all(root.join("assets").join("a")).unwrap();
        std::fs::write(root.join("assets").join("a").join("x.png"), "img").unwrap();

        rename_file_at(&root, "a.md", "b.md").unwrap();

        assert!(!root.join("a.md").exists());
        assert!(!root.join("a.essaydown.json").exists());
        assert!(!root.join("assets").join("a").exists());
        assert_eq!(
            std::fs::read_to_string(root.join("b.essaydown.json")).unwrap(),
            "{\"version\":1}"
        );
        assert!(root.join("assets").join("b").join("x.png").exists());
        let doc = std::fs::read_to_string(root.join("b.md")).unwrap();
        assert_eq!(doc, "See ![x](assets/b/x.png) and ![y](assets/b/y.png).");
    }

    #[test]
    fn rename_with_no_sidecar_or_assets_renames_only_the_doc() {
        let root = scratch_dir();
        std::fs::write(root.join("a.md"), "no images here").unwrap();

        rename_file_at(&root, "a.md", "b.md").unwrap();

        assert!(!root.join("a.md").exists());
        assert_eq!(std::fs::read_to_string(root.join("b.md")).unwrap(), "no images here");
        assert!(!root.join("b.essaydown.json").exists());
        assert!(!root.join("assets").exists());
    }

    #[test]
    fn rename_onto_an_existing_target_is_already_exists_and_changes_nothing() {
        let root = scratch_dir();
        std::fs::write(root.join("a.md"), "old").unwrap();
        std::fs::write(root.join("b.md"), "existing").unwrap();

        let err = rename_file_at(&root, "a.md", "b.md").unwrap_err();

        assert!(matches!(err, WorkspaceError::Io(io::ErrorKind::AlreadyExists)));
        assert_eq!(std::fs::read_to_string(root.join("a.md")).unwrap(), "old");
        assert_eq!(std::fs::read_to_string(root.join("b.md")).unwrap(), "existing");
    }

    #[test]
    fn rename_rolls_back_doc_and_sidecar_when_moving_assets_fails() {
        let root = scratch_dir();
        std::fs::write(root.join("a.md"), "![x](assets/a/x.png)").unwrap();
        std::fs::write(root.join("a.essaydown.json"), "{\"version\":1}").unwrap();
        std::fs::create_dir_all(root.join("assets").join("a")).unwrap();
        // A plain file already sitting at the assets destination blocks the directory rename with
        // a real I/O failure (the "simulated failure" the acceptance names).
        std::fs::write(root.join("assets").join("b"), "blocker").unwrap();

        let result = rename_file_at(&root, "a.md", "b.md");

        assert!(result.is_err());
        assert_eq!(std::fs::read_to_string(root.join("a.md")).unwrap(), "![x](assets/a/x.png)");
        assert_eq!(
            std::fs::read_to_string(root.join("a.essaydown.json")).unwrap(),
            "{\"version\":1}"
        );
        assert!(!root.join("b.md").exists());
        assert!(!root.join("b.essaydown.json").exists());
        assert!(root.join("assets").join("a").exists());
        assert_eq!(
            std::fs::read_to_string(root.join("assets").join("b")).unwrap(),
            "blocker"
        );
    }

    // --- delete_to_trash ---

    #[derive(Default)]
    struct RecordingTrash {
        calls: std::sync::Mutex<Vec<PathBuf>>,
    }

    impl TrashBackend for RecordingTrash {
        fn trash(&self, path: &Path) -> Result<(), WorkspaceError> {
            self.calls.lock().unwrap().push(path.to_path_buf());
            Ok(())
        }
    }

    #[test]
    fn delete_to_trash_calls_the_fake_once_per_existing_item() {
        let root = scratch_dir();
        std::fs::write(root.join("a.md"), "x").unwrap();
        std::fs::write(root.join("a.essaydown.json"), "{}").unwrap();
        std::fs::create_dir_all(root.join("assets").join("a")).unwrap();

        let backend = RecordingTrash::default();
        delete_to_trash_at(&root, "a.md", &backend).unwrap();

        let calls = backend.calls.lock().unwrap();
        assert_eq!(calls.len(), 3);
        assert!(calls.contains(&root.join("a.md")));
        assert!(calls.contains(&root.join("a.essaydown.json")));
        assert!(calls.contains(&root.join("assets").join("a")));
    }

    #[test]
    fn delete_to_trash_skips_a_missing_sidecar_and_assets_dir() {
        let root = scratch_dir();
        std::fs::write(root.join("a.md"), "x").unwrap();

        let backend = RecordingTrash::default();
        delete_to_trash_at(&root, "a.md", &backend).unwrap();

        let calls = backend.calls.lock().unwrap();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0], root.join("a.md"));
    }

    // --- civil_from_unix / unique_image_filename / save_image ---

    #[test]
    fn civil_from_unix_matches_known_epoch_points() {
        assert_eq!(civil_from_unix(0), (1970, 1, 1, 0, 0, 0));
        assert_eq!(civil_from_unix(1_700_000_000), (2023, 11, 14, 22, 13, 20));
        assert_eq!(civil_from_unix(1_000_000_000), (2001, 9, 9, 1, 46, 40));
    }

    #[test]
    fn unique_image_filename_matches_the_yyyymmdd_hhmmss_suffix_ext_shape() {
        let name = unique_image_filename("png").unwrap();
        // yyyyMMdd(8) - HHmmss(6) - xxxxxx(6) . ext(3): 8 + 1 + 6 + 1 + 6 + 1 + 3 = 26.
        assert_eq!(name.len(), 26);
        assert!(name.ends_with(".png"));
        assert_eq!(name.matches('-').count(), 2);
    }

    #[test]
    fn unique_image_filename_rejects_an_empty_a_too_long_and_a_non_alphanumeric_extension() {
        assert!(matches!(unique_image_filename("").unwrap_err(), WorkspaceError::InvalidPath));
        assert!(matches!(
            unique_image_filename("abcdeabcdea").unwrap_err(),
            WorkspaceError::InvalidPath
        ));
        assert!(matches!(
            unique_image_filename("png/../evil").unwrap_err(),
            WorkspaceError::InvalidPath
        ));
    }

    #[test]
    fn save_image_creates_the_assets_dir_and_writes_the_bytes_under_the_returned_fragment() {
        let root = scratch_dir();
        std::fs::write(root.join("a.md"), "# A\n").unwrap();

        let fragment = save_image_at(&root, "a.md", b"pngbytes", "png").unwrap();

        assert!(fragment.starts_with("assets/a/"), "fragment: {fragment}");
        assert!(fragment.ends_with(".png"));
        let filename = fragment.strip_prefix("assets/a/").unwrap();
        assert_eq!(
            std::fs::read(root.join("assets").join("a").join(filename)).unwrap(),
            b"pngbytes"
        );
    }

    #[test]
    fn save_image_two_calls_in_the_same_second_produce_two_distinct_files() {
        let root = scratch_dir();
        std::fs::write(root.join("a.md"), "# A\n").unwrap();

        let first = save_image_at(&root, "a.md", b"one", "png").unwrap();
        let second = save_image_at(&root, "a.md", b"two", "png").unwrap();

        assert_ne!(first, second);
        let entries: Vec<_> = std::fs::read_dir(root.join("assets").join("a")).unwrap().collect();
        assert_eq!(entries.len(), 2);
    }

    #[test]
    fn save_image_fragment_and_disk_location_are_relative_to_the_doc_directory_not_the_workspace_root() {
        let root = scratch_dir();
        std::fs::create_dir(root.join("sub")).unwrap();
        std::fs::write(root.join("sub").join("doc.md"), "# Doc\n").unwrap();

        let fragment = save_image_at(&root, "sub/doc.md", b"bytes", "png").unwrap();

        assert!(fragment.starts_with("assets/doc/"), "fragment: {fragment}");
        let filename = fragment.strip_prefix("assets/doc/").unwrap();
        assert!(root.join("sub").join("assets").join("doc").join(filename).exists());
        assert!(!root.join("assets").exists());
    }

    #[test]
    fn save_image_rejects_a_non_alphanumeric_extension_before_touching_disk() {
        let root = scratch_dir();
        std::fs::write(root.join("a.md"), "# A\n").unwrap();

        let err = save_image_at(&root, "a.md", b"bytes", "png/../evil").unwrap_err();

        assert!(matches!(err, WorkspaceError::InvalidPath));
        assert!(!root.join("assets").exists());
    }
}
