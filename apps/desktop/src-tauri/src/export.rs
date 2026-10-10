//! `export` (PRD §6.4, task 4.3): spawns the `pandoc` sidecar, feeding the document over stdin
//! (never a positional file argument — the frontend may hold edits the saved file does not), and
//! streams stderr to the frontend as it arrives. `packages/export/src/index.ts` is the argument
//! builders' own home (PRD §4's package comment: "spawning is in src-tauri"); this module mirrors
//! that package's `buildPandocArgs` shape in Rust, since the two cannot share code across the
//! language boundary — a change to one's argument order must be read against the other's.

use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};

use tauri::{AppHandle, Emitter, Runtime};
use tauri_plugin_shell::{process::CommandEvent, ShellExt};

use crate::workspace::WorkspaceError;

/// `fs:changed`'s sibling for export: one event per stderr line pandoc writes, in order.
pub(crate) const EXPORT_PROGRESS: &str = "export:progress";

#[derive(Clone, serde::Serialize)]
pub(crate) struct ExportProgress {
    pub chunk: String,
}

/// The command's success payload: `warning` is set exactly when pandoc exited 0 but could not
/// resolve every image (lesson [4.0]) — a warning the frontend shows beside the export, never a
/// thrown error.
#[derive(Clone, serde::Serialize, Debug, PartialEq, Eq)]
pub(crate) struct ExportOutcome {
    pub out_path: String,
    pub warning: Option<String>,
}

/// `export`'s failure modes beyond the `WorkspaceRoot` contract: an unresolvable `format`, an
/// explicitly empty `title`, an `out_path` that would overwrite the source, pandoc could not even
/// be started, or it exited non-zero.
#[derive(Debug)]
pub(crate) enum ExportError {
    Workspace(WorkspaceError),
    InvalidFormat(String),
    EmptyTitle,
    OutputOverwritesSource,
    Spawn(String),
    Pandoc { code: Option<i32>, stderr: String },
}

impl From<WorkspaceError> for ExportError {
    fn from(e: WorkspaceError) -> Self {
        ExportError::Workspace(e)
    }
}

impl serde::Serialize for ExportError {
    /// The IPC-facing shape (a bare string); as with `WorkspaceError`, Rust callers match on the
    /// enum variant directly and this is for the frontend only.
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let s = match self {
            ExportError::Workspace(e) => format!("Workspace:{e:?}"),
            ExportError::InvalidFormat(format) => format!("InvalidFormat:{format}"),
            ExportError::EmptyTitle => "EmptyTitle".to_string(),
            ExportError::OutputOverwritesSource => "OutputOverwritesSource".to_string(),
            ExportError::Spawn(message) => format!("Spawn:{message}"),
            ExportError::Pandoc { code, stderr } => format!("Pandoc:{code:?}:{stderr}"),
        };
        serializer.serialize_str(&s)
    }
}

/// Pandoc warns `[WARNING] Could not fetch resource …: replacing image with description` on stderr
/// for each image it cannot resolve, exiting 0 regardless (lesson [4.0]). This is the Rust side of
/// `packages/export/src/index.ts`'s `isMissingResourceWarning` — the same substring check, kept in
/// both languages because neither can call the other's function.
fn is_missing_resource_warning(stderr: &str) -> bool {
    stderr.contains("Could not fetch resource")
}

/// `relative_doc_path`'s own directory, in pandoc's `--resource-path` spelling: `"."` when the
/// document is at the workspace root. `relative_doc_path` has already been resolved through
/// `resolve_workspace_path`, so its parent is always the workspace root or a directory beneath it —
/// this never re-validates containment, it only takes the already-proven-safe string's own parent.
pub(crate) fn resource_dir_of(relative_doc_path: &str) -> String {
    match Path::new(relative_doc_path).parent() {
        Some(parent) if !parent.as_os_str().is_empty() => parent.to_string_lossy().into_owned(),
        _ => ".".to_string(),
    }
}

/// The exact grammar `capabilities/default.json`'s `-t` validator and `packages/export`'s
/// `isValidPandocFormat` both accept: one lowercase ASCII letter, then lowercase ASCII letters,
/// digits or `_` (`^[a-z][a-z0-9_]*$`), checked here in Rust terms because the capability file and
/// the TypeScript package cannot share code across either boundary. Called before any path
/// resolution or spawn (DECISIONS #review-4-r0 S3): the capability scope that used to be this
/// value's only gate never applied to `export`'s own Rust-side `ShellExt::sidecar`/`Command::spawn`
/// route (`shell_scope.rs`'s module comment), so a format reaching this function unchecked would
/// reach `pandoc -t <format>` — which, for an extension pandoc reads as a custom-writer suffix
/// (`.lua`), loads and runs arbitrary Lua from the workspace.
pub(crate) fn validate_format(format: &str) -> Result<(), ExportError> {
    let mut chars = format.chars();
    let starts_lowercase_letter = chars.next().is_some_and(|c| c.is_ascii_lowercase());
    let rest_is_lowercase_alnum_or_underscore =
        chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_');
    if starts_lowercase_letter && rest_is_lowercase_alnum_or_underscore {
        Ok(())
    } else {
        Err(ExportError::InvalidFormat(format.to_string()))
    }
}

/// Rejects an explicitly empty `title` (DECISIONS #review-4-r0 U1): the frontend sends `None`, not
/// `Some("")`, for "this document already has its own front-matter title" — an empty string here
/// is a caller bug, not a request for pandoc's own title-less default, so it is refused loudly
/// rather than silently producing `--metadata title=` (pandoc reads that as the empty string, not
/// as "omit the flag").
pub(crate) fn validate_title(title: &str) -> Result<(), ExportError> {
    if title.is_empty() {
        Err(ExportError::EmptyTitle)
    } else {
        Ok(())
    }
}

/// Rejects an `out_path` (already resolved through `resolve_workspace_path`, so both arguments are
/// canonical) that names the document itself or its `<stem>.essaydown.json` sidecar
/// (`workspace::sidecar_relative_for`'s own rule — recomputed here directly from the resolved path,
/// rather than calling that private helper, because `workspace.rs` is outside this task's scope):
/// pandoc's `-o` opens the target through a plain file write, so either case truncates the source
/// non-atomically before pandoc has finished reading it from stdin (DECISIONS #review-4-r0 C5).
pub(crate) fn reject_overwriting_source(out_path: &Path, doc_path: &Path) -> Result<(), ExportError> {
    if out_path == doc_path {
        return Err(ExportError::OutputOverwritesSource);
    }
    if let Some(stem) = doc_path.file_stem() {
        let sidecar = doc_path.with_file_name(format!("{}.essaydown.json", stem.to_string_lossy()));
        if out_path == sidecar {
            return Err(ExportError::OutputOverwritesSource);
        }
    }
    Ok(())
}

/// The fixed 9-token invocation `packages/export`'s `buildPandocArgs` also builds: no positional
/// input argument (the source is fed over stdin). The 7th token, `--pdf-engine=typst`, is load-
/// bearing as the literal bare name — never an absolute or relative path, and never any other
/// spelling of the same binary (task 4.17's own fix shape, reverted; lessons [4.17]): pandoc 3.11's
/// typst PDF builder picks its media-extraction directory by literal equality on the engine
/// argument's text (`withTempDir (program == "typst") "media"`, upstream `PDF.hs:86`), so anything
/// but the exact string `typst` extracts images to the system temp directory and writes a `.typ`
/// path typst cannot resolve, breaking every image-bearing export. `pandoc_path_env` is what makes
/// this literal immune to `PATH` shadowing instead.
///
/// `title`, when `Some`, appends two more tokens, `--metadata title=<title>`, mirroring
/// `buildPandocArgs`'s own optional `title` field (DECISIONS #review-4-r0 U1): the caller passes
/// `None` exactly when the document's own front-matter already carries a `title` key, so that
/// document's own title always wins (pandoc's `-M` overrides a yaml `title`, confirmed in the
/// pinned image) and this function never has to read the document's bytes itself to decide.
pub(crate) fn pandoc_args(resource_dir: &str, out_path: &str, format: &str, title: Option<&str>) -> Vec<String> {
    let mut args = vec![
        "-f".to_string(),
        "gfm".to_string(),
        "--standalone".to_string(),
        format!("--resource-path={resource_dir}"),
        "-o".to_string(),
        out_path.to_string(),
        "--pdf-engine=typst".to_string(),
        "-t".to_string(),
        format.to_string(),
    ];
    if let Some(title) = title {
        args.push("--metadata".to_string());
        args.push(format!("title={title}"));
    }
    args
}

/// The `typst` sidecar's absolute path, beside whichever binary is actually running — mirroring
/// exactly how the installed tauri-plugin-shell 2.3.6 resolves `shell().sidecar("pandoc")`
/// (`relative_command_path`, `src/process/mod.rs` in the cargo registry): `exe_dir` is the running
/// executable's own parent directory (the caller's `tauri::utils::platform::current_exe()?`'s
/// parent), bumped up one level when it is named `deps` (`cargo test`'s own layout), then joined
/// with `typst` (`typst.exe` under `cfg(windows)`, mirroring that function's own extension rule).
/// `--pdf-engine=typst` stays the bare name (see `pandoc_args`), so pandoc resolves it by a `PATH`
/// lookup on that name alone: the file this function points at must be named exactly `typst`
/// (`typst.exe` on Windows), never anything else, or the lookup misses it — Michael's condition
/// (the extracted `.deb`'s sidecar layout) is this function's own correctness, not a separate rule.
pub(crate) fn typst_sidecar_path(exe_dir: &Path) -> PathBuf {
    let base_dir = if exe_dir.ends_with("deps") {
        exe_dir.parent().unwrap_or(exe_dir)
    } else {
        exe_dir
    };
    #[cfg(windows)]
    {
        let mut path = base_dir.join("typst");
        path.as_mut_os_string().push(".exe");
        path
    }
    #[cfg(not(windows))]
    base_dir.join("typst")
}

/// The `PATH` the spawned `pandoc` child should see: `typst_sidecar_path(exe_dir)`'s own directory
/// first, then every entry of `inherited` in order. Pandoc spawns `--pdf-engine=typst` as a plain
/// process using *its own* environment (`getEnvironment`, upstream `PDF.hs`/`Process.hs`; GHC's
/// `process` passes that straight to `posix_spawnp`), so overriding the child's `PATH` — not the
/// argument's text — is what makes the literal bare name in `pandoc_args` resolve to the sidecar
/// ahead of any shadowing `typst` the inherited `PATH` might otherwise have found first (lessons
/// [4.17]). `std::env::join_paths` errs when an entry contains the platform's own separator.
pub(crate) fn pandoc_path_env(
    exe_dir: &Path,
    inherited: Option<&OsStr>,
) -> Result<OsString, std::env::JoinPathsError> {
    let sidecar_dir = typst_sidecar_path(exe_dir)
        .parent()
        .unwrap_or(exe_dir)
        .to_path_buf();
    let mut entries = vec![sidecar_dir];
    if let Some(inherited) = inherited {
        entries.extend(std::env::split_paths(inherited));
    }
    std::env::join_paths(entries)
}

/// Spawns the `pandoc` sidecar at `root` (so every relative argument above resolves against the
/// workspace root, exactly as `--resource-path`'s relative form requires), with `path_env`
/// (`pandoc_path_env`'s result) as its own `PATH` — the only way the literal `--pdf-engine=typst`
/// argument in `args` can resolve to the sidecar rather than a shadowing `typst` elsewhere on the
/// inherited `PATH` — writes `contents` to its stdin and closes it (dropping `child` closes the
/// pipe, signalling EOF; the background reader `spawn()` installs keeps its own handle, so this
/// does not kill the process), and streams every stderr line to the frontend as it arrives.
pub(crate) async fn run_pandoc<R: Runtime>(
    app: &AppHandle<R>,
    root: &Path,
    out_path: &str,
    args: &[String],
    contents: &str,
    path_env: &OsStr,
) -> Result<ExportOutcome, ExportError> {
    let (mut rx, mut child) = app
        .shell()
        .sidecar("pandoc")
        .map_err(|e| ExportError::Spawn(e.to_string()))?
        .args(args)
        .current_dir(root)
        .env("PATH", path_env)
        .spawn()
        .map_err(|e| ExportError::Spawn(e.to_string()))?;

    child
        .write(contents.as_bytes())
        .map_err(|e| ExportError::Spawn(e.to_string()))?;
    drop(child);

    let mut stderr = String::new();
    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stderr(bytes) => {
                let chunk = String::from_utf8_lossy(&bytes).into_owned();
                stderr.push_str(&chunk);
                stderr.push('\n');
                let _ = app.emit(EXPORT_PROGRESS, ExportProgress { chunk });
            }
            CommandEvent::Terminated(payload) => {
                return if payload.code == Some(0) {
                    let warning = is_missing_resource_warning(&stderr).then(|| stderr.trim().to_string());
                    Ok(ExportOutcome { out_path: out_path.to_string(), warning })
                } else {
                    Err(ExportError::Pandoc { code: payload.code, stderr })
                };
            }
            CommandEvent::Error(message) => return Err(ExportError::Spawn(message)),
            CommandEvent::Stdout(_) => {}
            // `CommandEvent` is `#[non_exhaustive]`; the installed tauri-plugin-shell 2.3.6 (read
            // from Cargo.lock) declares no other variant, so this never actually fires.
            _ => {}
        }
    }
    Err(ExportError::Spawn(
        "pandoc's event stream ended with no Terminated event".to_string(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resource_dir_of_root_level_document_is_dot() {
        assert_eq!(resource_dir_of("essay.md"), ".");
    }

    #[test]
    fn resource_dir_of_nested_document_is_its_own_directory() {
        assert_eq!(resource_dir_of("notes/essay.md"), "notes");
        assert_eq!(resource_dir_of("a/b/essay.md"), "a/b");
    }

    #[test]
    fn pandoc_args_has_no_positional_input_argument() {
        let args = pandoc_args(".", "essay.docx", "docx", None);
        assert_eq!(
            args,
            vec![
                "-f",
                "gfm",
                "--standalone",
                "--resource-path=.",
                "-o",
                "essay.docx",
                "--pdf-engine=typst",
                "-t",
                "docx",
            ]
        );
    }

    #[test]
    fn pandoc_args_with_no_title_is_the_fixed_9_token_shape() {
        assert_eq!(pandoc_args(".", "essay.docx", "docx", None).len(), 9);
    }

    #[test]
    fn pandoc_args_with_a_title_appends_the_metadata_tokens() {
        let args = pandoc_args(".", "essay.epub", "epub", Some("essay-fixture"));
        assert_eq!(
            args,
            vec![
                "-f",
                "gfm",
                "--standalone",
                "--resource-path=.",
                "-o",
                "essay.epub",
                "--pdf-engine=typst",
                "-t",
                "epub",
                "--metadata",
                "title=essay-fixture",
            ]
        );
    }

    #[test]
    fn validate_title_accepts_a_non_empty_string() {
        assert!(validate_title("essay-fixture").is_ok());
    }

    #[test]
    fn validate_title_rejects_an_empty_string() {
        assert!(matches!(validate_title(""), Err(ExportError::EmptyTitle)));
    }

    #[test]
    fn typst_sidecar_path_dev_layout_is_beside_the_debug_binary() {
        let exe_dir = Path::new("/work/target/debug");
        let path = typst_sidecar_path(exe_dir);
        assert_eq!(path.file_stem().unwrap(), "typst");
        #[cfg(windows)]
        assert_eq!(path.file_name().unwrap(), "typst.exe");
        #[cfg(not(windows))]
        assert_eq!(path.file_name().unwrap(), "typst");
        assert_eq!(path.parent().unwrap(), exe_dir);
    }

    #[test]
    fn typst_sidecar_path_cargo_test_deps_layout_goes_up_one_level() {
        let exe_dir = Path::new("/work/target/debug/deps");
        let path = typst_sidecar_path(exe_dir);
        assert_eq!(path.file_stem().unwrap(), "typst");
        #[cfg(windows)]
        assert_eq!(path.file_name().unwrap(), "typst.exe");
        #[cfg(not(windows))]
        assert_eq!(path.file_name().unwrap(), "typst");
        assert_eq!(path.parent().unwrap(), Path::new("/work/target/debug"));
    }

    #[test]
    fn typst_sidecar_path_macos_bundle_layout_is_beside_the_app_binary() {
        let exe_dir = Path::new("/Applications/EssayDown.app/Contents/MacOS");
        let path = typst_sidecar_path(exe_dir);
        assert_eq!(path.file_stem().unwrap(), "typst");
        #[cfg(windows)]
        assert_eq!(path.file_name().unwrap(), "typst.exe");
        #[cfg(not(windows))]
        assert_eq!(path.file_name().unwrap(), "typst");
        assert_eq!(path.parent().unwrap(), exe_dir);
    }

    #[test]
    fn typst_sidecar_path_linux_package_layout_is_beside_the_installed_binary() {
        let exe_dir = Path::new("/usr/bin");
        let path = typst_sidecar_path(exe_dir);
        assert_eq!(path.file_stem().unwrap(), "typst");
        #[cfg(windows)]
        assert_eq!(path.file_name().unwrap(), "typst.exe");
        #[cfg(not(windows))]
        assert_eq!(path.file_name().unwrap(), "typst");
        assert_eq!(path.parent().unwrap(), exe_dir);
    }

    #[test]
    fn pandoc_path_env_prepends_the_sidecar_directory_before_every_inherited_entry() {
        let exe_dir = Path::new("/work/target/debug");
        let shadow = PathBuf::from("/tmp/shadow");
        let other = PathBuf::from("/usr/bin");
        let inherited = std::env::join_paths([&shadow, &other]).unwrap();
        let result = pandoc_path_env(exe_dir, Some(inherited.as_os_str())).unwrap();
        let entries: Vec<PathBuf> = std::env::split_paths(&result).collect();
        assert_eq!(entries[0], typst_sidecar_path(exe_dir).parent().unwrap());
        assert_eq!(&entries[1..], &[shadow, other]);
    }

    #[test]
    fn pandoc_path_env_with_no_inherited_path_has_exactly_one_entry() {
        let exe_dir = Path::new("/work/target/debug");
        let result = pandoc_path_env(exe_dir, None).unwrap();
        let entries: Vec<PathBuf> = std::env::split_paths(&result).collect();
        assert_eq!(entries, vec![typst_sidecar_path(exe_dir).parent().unwrap().to_path_buf()]);
    }

    #[test]
    fn pandoc_path_env_cargo_test_deps_layout_first_entry_is_debug_not_deps() {
        let exe_dir = Path::new("/work/target/debug/deps");
        let result = pandoc_path_env(exe_dir, None).unwrap();
        let entries: Vec<PathBuf> = std::env::split_paths(&result).collect();
        assert_eq!(entries[0], Path::new("/work/target/debug"));
    }

    #[test]
    #[cfg(unix)]
    fn pandoc_path_env_errs_when_the_sidecar_directory_contains_the_path_list_separator() {
        let exe_dir = Path::new("/work/weird:dir");
        assert!(pandoc_path_env(exe_dir, None).is_err());
    }

    #[test]
    #[cfg(windows)]
    fn pandoc_path_env_errs_when_the_sidecar_directory_contains_the_path_list_separator() {
        let exe_dir = Path::new("/work/weird\"dir");
        assert!(pandoc_path_env(exe_dir, None).is_err());
    }

    #[test]
    fn missing_resource_warning_is_detected_only_by_its_own_substring() {
        assert!(is_missing_resource_warning(
            "[WARNING] Could not fetch resource assets/essay/x.png: replacing image with description"
        ));
        assert!(!is_missing_resource_warning(""));
        assert!(!is_missing_resource_warning("[WARNING] Duplicate link reference"));
    }

    #[test]
    fn export_outcome_serializes_warning_as_present_or_absent() {
        let ok = serde_json::to_value(ExportOutcome { out_path: "essay.docx".to_string(), warning: None }).unwrap();
        assert_eq!(ok["warning"], serde_json::Value::Null);
        let warned = serde_json::to_value(ExportOutcome {
            out_path: "essay.docx".to_string(),
            warning: Some("missing".to_string()),
        })
        .unwrap();
        assert_eq!(warned["warning"], serde_json::Value::String("missing".to_string()));
    }

    #[test]
    fn export_error_serializes_each_variant_to_a_distinct_prefix() {
        let workspace = serde_json::to_value(ExportError::Workspace(WorkspaceError::NoWorkspace)).unwrap();
        assert_eq!(workspace, serde_json::Value::String("Workspace:NoWorkspace".to_string()));
        let invalid_format = serde_json::to_value(ExportError::InvalidFormat("x.lua".to_string())).unwrap();
        assert_eq!(invalid_format, serde_json::Value::String("InvalidFormat:x.lua".to_string()));
        let empty_title = serde_json::to_value(ExportError::EmptyTitle).unwrap();
        assert_eq!(empty_title, serde_json::Value::String("EmptyTitle".to_string()));
        let overwrites_source = serde_json::to_value(ExportError::OutputOverwritesSource).unwrap();
        assert_eq!(overwrites_source, serde_json::Value::String("OutputOverwritesSource".to_string()));
        let spawn = serde_json::to_value(ExportError::Spawn("boom".to_string())).unwrap();
        assert_eq!(spawn, serde_json::Value::String("Spawn:boom".to_string()));
        let pandoc = serde_json::to_value(ExportError::Pandoc { code: Some(1), stderr: "bad".to_string() }).unwrap();
        assert_eq!(pandoc, serde_json::Value::String("Pandoc:Some(1):bad".to_string()));
    }

    #[test]
    fn validate_format_accepts_the_lowercase_alnum_underscore_grammar() {
        assert!(validate_format("docx").is_ok());
        assert!(validate_format("html5").is_ok());
        assert!(validate_format("a_b9").is_ok());
    }

    #[test]
    fn validate_format_rejects_a_dot_extension() {
        assert!(matches!(validate_format("x.lua"), Err(ExportError::InvalidFormat(f)) if f == "x.lua"));
    }

    #[test]
    fn validate_format_rejects_a_traversal_segment() {
        assert!(matches!(validate_format("../x.lua"), Err(ExportError::InvalidFormat(f)) if f == "../x.lua"));
    }

    #[test]
    fn validate_format_rejects_an_absolute_path() {
        assert!(matches!(validate_format("/tmp/x.lua"), Err(ExportError::InvalidFormat(f)) if f == "/tmp/x.lua"));
    }

    #[test]
    fn validate_format_rejects_a_semicolon() {
        assert!(matches!(validate_format("html;x"), Err(ExportError::InvalidFormat(f)) if f == "html;x"));
    }

    #[test]
    fn validate_format_rejects_a_leading_uppercase_letter() {
        assert!(matches!(validate_format("Html"), Err(ExportError::InvalidFormat(f)) if f == "Html"));
    }

    #[test]
    fn validate_format_rejects_an_empty_string() {
        assert!(matches!(validate_format(""), Err(ExportError::InvalidFormat(f)) if f.is_empty()));
    }

    #[test]
    fn reject_overwriting_source_rejects_the_document_itself() {
        let doc = Path::new("/root/a.md");
        assert!(matches!(reject_overwriting_source(doc, doc), Err(ExportError::OutputOverwritesSource)));
    }

    #[test]
    fn reject_overwriting_source_rejects_the_documents_sidecar() {
        let doc = Path::new("/root/a.md");
        let sidecar = Path::new("/root/a.essaydown.json");
        assert!(matches!(reject_overwriting_source(sidecar, doc), Err(ExportError::OutputOverwritesSource)));
    }

    #[test]
    fn reject_overwriting_source_accepts_a_distinct_output_path() {
        let doc = Path::new("/root/a.md");
        let out = Path::new("/root/out/a.docx");
        assert!(reject_overwriting_source(out, doc).is_ok());
    }
}
