#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();

    // Embedded WebDriver server for the WDIO Tauri plugin's macOS shell-e2e provider (PRD §4:
    // "debug/test builds only"); ubuntu and windows drive the app through the cargo-installed
    // tauri-driver instead and never load this plugin.
    #[cfg(debug_assertions)]
    let builder = builder.plugin(tauri_plugin_wdio_webdriver::init());

    builder
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
