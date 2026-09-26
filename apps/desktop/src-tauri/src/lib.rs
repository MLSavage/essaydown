mod commands;
mod watch;
mod workspace;

use commands::{WatchState, WorkspaceState};

/// Plugin registration and the IPC surface, shared by `run()` (a real runtime) and the `commands`
/// integration test (`tauri::test`'s `MockRuntime`), so the test exercises the exact wiring `run()`
/// installs rather than a hand-rolled copy of it.
///
/// Registration order matters (PRD §6.4, tested in `commands::tests`): tauri-plugin-fs must load
/// before tauri-plugin-persisted-scope, which restores a saved scope onto the fs plugin's own scope
/// object and therefore requires it to already be managed.
pub(crate) fn configure<R: tauri::Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    // Embedded WebDriver server for the WDIO Tauri plugin's macOS and Windows shell-e2e provider
    // (PRD §4: "debug/test builds only"; Windows moved here at 2.1.g1 — actions/runner-images
    // #14738 makes the tauri-driver -> msedgedriver route unable to create a session at all).
    // Ubuntu alone drives the app through the cargo-installed tauri-driver and never loads this
    // plugin.
    #[cfg(debug_assertions)]
    let builder = builder.plugin(tauri_plugin_wdio_webdriver::init());

    builder
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_persisted_scope::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(WorkspaceState::default())
        .manage(WatchState::default())
        .invoke_handler(tauri::generate_handler![
            commands::open_folder,
            commands::list_tree,
            commands::read_doc,
            commands::write_doc,
            commands::read_sidecar,
            commands::write_sidecar,
            commands::new_file,
            commands::rename_file,
            commands::delete_to_trash,
            commands::reveal_in_folder,
            commands::watch_folder,
        ])
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    configure(tauri::Builder::default())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
