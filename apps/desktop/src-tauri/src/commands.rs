//! The IPC surface (PRD §6.4) built across 2.2 and 2.3: `open_folder`, `list_tree`, `read_doc`,
//! `write_doc`, `read_sidecar`, `write_sidecar`, `new_file`, `rename_file`, `delete_to_trash`,
//! `reveal_in_folder`, and 2.5's `watch_folder`. Each is a thin adapter over `workspace`'s pure path-resolution and file-I/O
//! functions, which carry all the logic cargo tests exercise directly.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tauri::{Emitter, Manager};
use tauri_plugin_fs::FsExt;

use crate::workspace::{
    self, delete_to_trash_at, read_doc_at, read_sidecar_at, save_image_at, write_doc_at,
    write_sidecar_at, SystemTrash, TreeEntry, WorkspaceError,
};
use crate::watch::{watch_folder_at, FsChanged, FS_CHANGED};

/// The single `WorkspaceRoot` (PRD §6.4): `None` until `open_folder` succeeds.
#[derive(Default)]
pub struct WorkspaceState(pub Mutex<Option<PathBuf>>);

/// The one live folder watcher (`watch_folder`); a new call replaces, and so stops, the previous one.
#[derive(Default)]
pub struct WatchState(pub Mutex<Option<notify::RecommendedWatcher>>);

fn current_root(state: &tauri::State<WorkspaceState>) -> Result<PathBuf, WorkspaceError> {
    state.0.lock().unwrap().clone().ok_or(WorkspaceError::NoWorkspace)
}

#[tauri::command]
pub fn open_folder<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: tauri::State<WorkspaceState>,
    path: String,
) -> Result<String, WorkspaceError> {
    let requested = PathBuf::from(&path);
    let canon = requested.canonicalize()?;
    if !canon.is_dir() {
        return Err(WorkspaceError::InvalidPath);
    }

    app.fs_scope()
        .allow_directory(&canon, true)
        .map_err(|_| WorkspaceError::InvalidPath)?;
    app.asset_protocol_scope()
        .allow_directory(&canon, true)
        .map_err(|_| WorkspaceError::InvalidPath)?;

    *state.0.lock().unwrap() = Some(canon.clone());
    Ok(canon.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn list_tree(state: tauri::State<WorkspaceState>) -> Result<Vec<TreeEntry>, WorkspaceError> {
    workspace::list_tree_at(&current_root(&state)?)
}

#[tauri::command]
pub fn read_doc(state: tauri::State<WorkspaceState>, path: String) -> Result<String, WorkspaceError> {
    read_doc_at(&current_root(&state)?, &path)
}

#[tauri::command]
pub fn write_doc(
    state: tauri::State<WorkspaceState>,
    path: String,
    contents: String,
) -> Result<(), WorkspaceError> {
    write_doc_at(&current_root(&state)?, &path, &contents)
}

#[tauri::command]
pub fn read_sidecar(
    state: tauri::State<WorkspaceState>,
    path: String,
) -> Result<Option<String>, WorkspaceError> {
    read_sidecar_at(&current_root(&state)?, &path)
}

#[tauri::command]
pub fn write_sidecar(
    state: tauri::State<WorkspaceState>,
    path: String,
    contents: String,
) -> Result<(), WorkspaceError> {
    write_sidecar_at(&current_root(&state)?, &path, &contents)
}

/// `watch_folder` (PRD §6.4): emits `fs:changed` with `{ path }` for every document under
/// `path` (workspace-relative; the empty path is the root) whose bytes change, until the next call.
#[tauri::command]
pub fn watch_folder<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: tauri::State<WorkspaceState>,
    watch: tauri::State<WatchState>,
    path: String,
) -> Result<(), WorkspaceError> {
    let emitter = app.clone();
    let watcher = watch_folder_at(&current_root(&state)?, &path, move |changed| {
        // An emit fails only when the app is shutting down; there is no one left to tell.
        let _ = emitter.emit(FS_CHANGED, FsChanged { path: changed });
    })?;
    *watch.0.lock().unwrap() = Some(watcher);
    Ok(())
}

#[tauri::command]
pub fn new_file(state: tauri::State<WorkspaceState>) -> Result<String, WorkspaceError> {
    workspace::new_file_at(&current_root(&state)?)
}

#[tauri::command]
pub fn rename_file(
    state: tauri::State<WorkspaceState>,
    old_path: String,
    new_path: String,
) -> Result<(), WorkspaceError> {
    workspace::rename_file_at(&current_root(&state)?, &old_path, &new_path)
}

#[tauri::command]
pub fn delete_to_trash(
    state: tauri::State<WorkspaceState>,
    path: String,
) -> Result<(), WorkspaceError> {
    delete_to_trash_at(&current_root(&state)?, &path, &SystemTrash)
}

/// `save_image` (PRD §6.4): writes a pasted/dropped image's bytes into the open document's own
/// `assets/<stem>` directory and returns the document-directory-relative fragment the frontend
/// inserts as `![](…)`.
#[tauri::command]
pub fn save_image(
    state: tauri::State<WorkspaceState>,
    doc_path: String,
    bytes: Vec<u8>,
    extension: String,
) -> Result<String, WorkspaceError> {
    save_image_at(&current_root(&state)?, &doc_path, &bytes, &extension)
}

#[tauri::command]
pub fn reveal_in_folder(
    state: tauri::State<WorkspaceState>,
    path: String,
) -> Result<(), WorkspaceError> {
    let resolved = workspace::resolve_for_reveal(&current_root(&state)?, &path)?;
    reveal(&resolved)
}

/// Reveals `path` in the OS file manager: `open -R` selects the file on macOS, `explorer /select,`
/// selects it on Windows. There is no cross-desktop-environment equivalent on Linux, so `xdg-open`
/// on the containing directory is the honest substitute here — it opens the folder without
/// selecting the file, recorded rather than silently claimed as a full reveal.
#[cfg(target_os = "macos")]
fn reveal(path: &Path) -> Result<(), WorkspaceError> {
    std::process::Command::new("open").arg("-R").arg(path).spawn()?;
    Ok(())
}

#[cfg(target_os = "windows")]
fn reveal(path: &Path) -> Result<(), WorkspaceError> {
    std::process::Command::new("explorer")
        .arg(format!("/select,{}", path.display()))
        .spawn()?;
    Ok(())
}

#[cfg(all(unix, not(target_os = "macos")))]
fn reveal(path: &Path) -> Result<(), WorkspaceError> {
    let parent = path.parent().unwrap_or(path);
    std::process::Command::new("xdg-open").arg(parent).spawn()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    /// `lib.rs`'s `run()` is the one place both plugins are registered (`main.rs` only calls
    /// `desktop_lib::run()`); the persisted-scope plugin restores onto the fs plugin's own scope
    /// object at setup and therefore needs it already managed, so `tauri-plugin-fs::init()` must
    /// textually precede `tauri-plugin-persisted-scope::init()`'s `.plugin(...)` call.
    #[test]
    fn fs_plugin_registered_before_persisted_scope_plugin() {
        let lib_rs = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/lib.rs"))
            .expect("src/lib.rs must exist");
        let fs_pos = lib_rs
            .find(".plugin(tauri_plugin_fs::init())")
            .expect("tauri_plugin_fs::init() must be registered");
        let persisted_pos = lib_rs
            .find(".plugin(tauri_plugin_persisted_scope::init())")
            .expect("tauri_plugin_persisted_scope::init() must be registered");
        assert!(
            fs_pos < persisted_pos,
            "tauri-plugin-fs must be registered before tauri-plugin-persisted-scope"
        );
    }

    /// `open_folder` extends the fs and asset-protocol scopes to only the folder the user chose
    /// (PRD §6.4); a `**` entry in the shipped capability file would grant every command it names
    /// access to the whole filesystem regardless of that runtime grant, so the static file itself
    /// must never carry one.
    #[test]
    fn capability_file_contains_no_double_star_scope() {
        let capability = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/capabilities/default.json"
        ))
        .expect("capabilities/default.json must exist");
        assert!(
            !capability.contains("**"),
            "capabilities/default.json must not grant a ** scope"
        );
    }

    /// Builds the real app (`crate::configure`, the real `tauri.conf.json`/capabilities, a
    /// `MockRuntime` window) and drives `open_folder` and `list_tree` through actual IPC, so this
    /// proves the commands are reachable under the shipped ACL, not just that the pure functions in
    /// `workspace` are correct — a mocked `AppHandle` alone could not exercise the capability file.
    fn test_app() -> (
        tauri::App<tauri::test::MockRuntime>,
        tauri::WebviewWindow<tauri::test::MockRuntime>,
    ) {
        let app = crate::configure(tauri::test::mock_builder())
            .build(tauri::generate_context!())
            .expect("failed to build test app");
        let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("failed to build test webview");
        (app, webview)
    }

    fn invoke_request(cmd: &str, args: serde_json::Value) -> tauri::webview::InvokeRequest {
        tauri::webview::InvokeRequest {
            cmd: cmd.into(),
            callback: tauri::ipc::CallbackFn(0),
            error: tauri::ipc::CallbackFn(1),
            url: if cfg!(any(windows, target_os = "android")) {
                "http://tauri.localhost"
            } else {
                "tauri://localhost"
            }
            .parse()
            .unwrap(),
            body: tauri::ipc::InvokeBody::Json(args),
            headers: Default::default(),
            invoke_key: tauri::test::INVOKE_KEY.to_string(),
        }
    }

    #[test]
    fn open_folder_then_list_tree_and_write_doc_round_trip_over_real_ipc() {
        let (_app, webview) = test_app();
        let root = std::env::temp_dir().join(format!(
            "essaydown-ipc-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let root = root.canonicalize().unwrap();
        std::fs::write(root.join("a.md"), "hello").unwrap();

        let opened = tauri::test::get_ipc_response(
            &webview,
            invoke_request(
                "open_folder",
                serde_json::json!({ "path": root.to_str().unwrap() }),
            ),
        )
        .expect("open_folder must be allowed by the app's capabilities");
        assert_eq!(
            opened.deserialize::<String>().unwrap(),
            root.to_str().unwrap()
        );

        let tree = tauri::test::get_ipc_response(&webview, invoke_request("list_tree", serde_json::json!({})))
            .expect("list_tree must be allowed by the app's capabilities")
            .deserialize::<Vec<crate::workspace::TreeEntry>>()
            .unwrap();
        assert_eq!(
            tree,
            vec![crate::workspace::TreeEntry { path: "a.md".to_string(), cloud_only: false }]
        );

        tauri::test::get_ipc_response(
            &webview,
            invoke_request(
                "write_doc",
                serde_json::json!({ "path": "b.md", "contents": "new" }),
            ),
        )
        .expect("write_doc must be allowed by the app's capabilities");
        assert_eq!(std::fs::read_to_string(root.join("b.md")).unwrap(), "new");

        tauri::test::get_ipc_response(&webview, invoke_request("watch_folder", serde_json::json!({ "path": "" })))
            .expect("watch_folder must be allowed by the app's capabilities");
    }
}
