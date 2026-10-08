//! `export` (PRD §6.4, task 4.3): spawns the `pandoc` sidecar, feeding the document over stdin
//! (never a positional file argument — the frontend may hold edits the saved file does not), and
//! streams stderr to the frontend as it arrives. `packages/export/src/index.ts` is the argument
//! builders' own home (PRD §4's package comment: "spawning is in src-tauri"); this module mirrors
//! that package's `buildPandocArgs` shape in Rust, since the two cannot share code across the
//! language boundary — a change to one's argument order must be read against the other's.

use std::path::Path;

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

/// `export`'s failure modes beyond the `WorkspaceRoot` contract: pandoc could not even be started,
/// or it exited non-zero.
#[derive(Debug)]
pub(crate) enum ExportError {
    Workspace(WorkspaceError),
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

/// The fixed 9-token invocation `packages/export`'s `buildPandocArgs` also builds: no positional
/// input argument (the source is fed over stdin).
pub(crate) fn pandoc_args(resource_dir: &str, out_path: &str, format: &str) -> Vec<String> {
    vec![
        "-f".to_string(),
        "gfm".to_string(),
        "--standalone".to_string(),
        format!("--resource-path={resource_dir}"),
        "-o".to_string(),
        out_path.to_string(),
        "--pdf-engine=typst".to_string(),
        "-t".to_string(),
        format.to_string(),
    ]
}

/// Spawns the `pandoc` sidecar at `root` (so every relative argument above resolves against the
/// workspace root, exactly as `--resource-path`'s relative form requires), writes `contents` to its
/// stdin and closes it (dropping `child` closes the pipe, signalling EOF; the background reader
/// `spawn()` installs keeps its own handle, so this does not kill the process), and streams every
/// stderr line to the frontend as it arrives.
pub(crate) async fn run_pandoc<R: Runtime>(
    app: &AppHandle<R>,
    root: &Path,
    out_path: &str,
    args: &[String],
    contents: &str,
) -> Result<ExportOutcome, ExportError> {
    let (mut rx, mut child) = app
        .shell()
        .sidecar("pandoc")
        .map_err(|e| ExportError::Spawn(e.to_string()))?
        .args(args)
        .current_dir(root)
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
        let args = pandoc_args(".", "essay.docx", "docx");
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
        let spawn = serde_json::to_value(ExportError::Spawn("boom".to_string())).unwrap();
        assert_eq!(spawn, serde_json::Value::String("Spawn:boom".to_string()));
        let pandoc = serde_json::to_value(ExportError::Pandoc { code: Some(1), stderr: "bad".to_string() }).unwrap();
        assert_eq!(pandoc, serde_json::Value::String("Pandoc:Some(1):bad".to_string()));
    }
}
