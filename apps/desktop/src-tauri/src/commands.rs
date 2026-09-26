//! The IPC surface (PRD §6.4) built at this task: `open_folder`, `list_tree`, `read_doc`,
//! `write_doc`, `read_sidecar`, `write_sidecar`. Each is a thin adapter over `workspace`'s pure
//! path-resolution and file-I/O functions, which carry all the logic cargo tests exercise directly.

use std::path::PathBuf;
use std::sync::Mutex;

use tauri::Manager;
use tauri_plugin_fs::FsExt;

use crate::workspace::{
    self, read_doc_at, read_sidecar_at, write_doc_at, write_sidecar_at, TreeEntry, WorkspaceError,
};

/// The single `WorkspaceRoot` (PRD §6.4): `None` until `open_folder` succeeds.
#[derive(Default)]
pub struct WorkspaceState(pub Mutex<Option<PathBuf>>);

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
    }
}
