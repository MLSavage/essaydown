mod coach_key;
mod commands;
mod menu;
mod settings;
mod watch;
mod workspace;

use coach_key::CoachKeyState;
use commands::{WatchState, WorkspaceState};

/// Plugin registration and the IPC surface, shared by `run()` (a real runtime) and the `commands`
/// integration test (`tauri::test`'s `MockRuntime`), so the test exercises the exact wiring `run()`
/// installs rather than a hand-rolled copy of it. The macOS menu is `run()`'s alone, not this
/// function's: `muda::Menu::new` asserts the calling thread is the main thread
/// (muda-0.19.3 `src/platform_impl/macos/mod.rs:132`), libtest runs every `#[test]` on a worker
/// thread, and `tauri::test::MockRuntime` runs a main-thread task inline on the calling thread
/// while the app is not yet running (tauri-2.11.5 `src/test/mock_runtime.rs:76-91`) — so a menu
/// registered here would reach `muda::Menu::new` from `commands::tests::test_app()`'s builder
/// thread and panic on macOS alone.
///
/// Registration order matters (PRD §6.4, tested in `commands::tests`): tauri-plugin-fs must load
/// before tauri-plugin-persisted-scope, which restores a saved scope onto the fs plugin's own scope
/// object and therefore requires it to already be managed.
pub(crate) fn configure<R: tauri::Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    // Embedded WebDriver server for the WDIO Tauri plugin's macOS and Windows shell-e2e provider
    // (PRD §4: "debug/test builds only"; Windows moved here at 2.1.g1 — actions/runner-images
    // #14738 makes the tauri-driver -> msedgedriver route unable to create a session at all).
    // It is registered on every debug build, Linux included; Ubuntu's shell e2e alone drives the
    // app through the cargo-installed tauri-driver instead and never connects to it.
    #[cfg(debug_assertions)]
    let builder = builder.plugin(tauri_plugin_wdio_webdriver::init());

    builder
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_persisted_scope::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(WorkspaceState::default())
        .manage(WatchState::default())
        // `SystemKeyring` in production; `cargo test` compiles this crate with `cfg(test)` set
        // (it is the same `configure()` `run()` and the `commands`/`coach_key` test modules both
        // call, task 2.7's description: "an in-memory backend under test"), so `cargo test` never
        // touches a real OS credential store.
        .manage(CoachKeyState({
            #[cfg(test)]
            let backend: Box<dyn coach_key::CoachKeyBackend> = Box::new(coach_key::InMemoryBackend::default());
            #[cfg(not(test))]
            let backend: Box<dyn coach_key::CoachKeyBackend> = Box::new(coach_key::SystemKeyring);
            backend
        }))
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
            commands::save_image,
            commands::get_settings,
            commands::set_settings,
            commands::set_coach_key,
            commands::has_coach_key,
            commands::clear_coach_key,
        ])
}

/// The single place in this crate that invokes Tauri's context-generating macro, generic over the
/// runtime so `run()` (the real `Wry` runtime) and `commands::tests::test_app()` (`tauri::test`'s
/// `MockRuntime`) share it — two separate invocations each embed a `#[no_mangle]` `_EMBED_INFO_PLIST`
/// static on macOS, which the linker then rejects as a duplicate symbol (task 2.11).
pub(crate) fn context<R: tauri::Runtime>() -> tauri::Context<R> {
    tauri::generate_context!()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Reachable stderr line for the shell e2e's backend-log-capture presence case
    // (DECISIONS #052 gap (d), option A): a debug-only startup banner, never a product
    // diagnostic. Never in `configure()`, which `cargo test`'s `MockRuntime` suites also call.
    #[cfg(debug_assertions)]
    eprintln!("essaydown: backend started");

    let builder = configure(tauri::Builder::default());

    // macOS only (Linux and Windows keep no menu bar): tauri's default menu with its Quit replaced
    // by a custom item that closes every window through the frontend's close barrier, because the
    // predefined Quit (`terminate:`) raises no window or exit event (`menu.rs`, #review-2-r1 U2).
    #[cfg(target_os = "macos")]
    let builder = builder
        .menu(|handle| menu::build_menu(handle, &menu::default_menu_spec()))
        .on_menu_event(|app, event| {
            if menu::quit_requested(event.id()) {
                menu::request_quit(app);
            }
        });

    builder
        .run(context())
        .expect("error while running tauri application");
}
