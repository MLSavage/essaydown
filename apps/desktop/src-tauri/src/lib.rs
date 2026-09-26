#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();

    // Embedded WebDriver server for the WDIO Tauri plugin's macOS and Windows shell-e2e provider
    // (PRD §4: "debug/test builds only"; Windows moved here at 2.1.g1 — actions/runner-images
    // #14738 makes the tauri-driver -> msedgedriver route unable to create a session at all).
    // Ubuntu alone drives the app through the cargo-installed tauri-driver and never loads this
    // plugin.
    #[cfg(debug_assertions)]
    let builder = builder.plugin(tauri_plugin_wdio_webdriver::init());

    builder
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
