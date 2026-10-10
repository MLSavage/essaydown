//! No production code: `capabilities/default.json` (task 4.2) granted a `shell:allow-spawn` scope
//! here, meant as "the only thing that can invoke either sidecar" (DECISIONS #review-4-r0 S3); it
//! never was — `export.rs`'s own Rust-side `ShellExt::sidecar`/`Command::spawn` route to `pandoc`
//! and `typst` never consulted it at all (confirmed by reading the installed `tauri-plugin-shell`
//! 2.3.6 crate), and no `@tauri-apps/plugin-shell` import exists under `apps/desktop/src` for the
//! frontend to reach the webview-facing `plugin:shell|spawn` IPC command the scope actually
//! governed. Task 4.23 removed the permission entirely (`export`'s own `format`/`out_path` checks,
//! `export.rs`, are what guard the Rust-side route now); this module hosts the cargo test proving
//! `plugin:shell|spawn` of each sidecar is denied outright with no permission granting it (the same
//! `tauri::test::MockRuntime` + `get_ipc_response` pattern `commands::tests` uses), so a capability
//! file that ever re-grants the scope is caught here, not assumed.

#[cfg(test)]
mod tests {
    /// Builds the real app (`crate::configure`, the real `tauri.conf.json`/capabilities, a
    /// `MockRuntime` window), mirroring `commands::tests::test_app` exactly (duplicated rather than
    /// shared across the two private test modules).
    fn test_app() -> (
        tauri::App<tauri::test::MockRuntime>,
        tauri::WebviewWindow<tauri::test::MockRuntime>,
    ) {
        let app = crate::configure(tauri::test::mock_builder())
            .build(crate::context())
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

    /// Spawns `binaries/pandoc` as a sidecar with `args` through the real `plugin:shell|spawn` IPC
    /// command (the same command `export`, task 4.3, will drive), returning the scope's verdict as
    /// a string: `Ok` on success, or the `Err` payload's message (always a plain string —
    /// `tauri_plugin_shell::Error` serializes via `Display`, never a structured object).
    fn spawn_pandoc(args: &[&str]) -> Result<(), String> {
        spawn_sidecar("binaries/pandoc", args)
    }

    fn spawn_sidecar(program: &str, args: &[&str]) -> Result<(), String> {
        let (_app, webview) = test_app();
        let response = tauri::test::get_ipc_response(
            &webview,
            invoke_request(
                "plugin:shell|spawn",
                serde_json::json!({
                    "program": program,
                    "args": args,
                    "onEvent": "__CHANNEL__:0",
                    "options": { "sidecar": true },
                }),
            ),
        );
        match response {
            Ok(_) => Ok(()),
            Err(v) => Err(v.as_str().expect("shell plugin errors serialize as a string").to_string()),
        }
    }

    /// The exact 9-token shape task 4.2 names: `-f gfm --standalone --resource-path=<path> -o
    /// <path> --pdf-engine=typst -t <format>`. `export` (task 4.3/4.4) sends markdown over stdin,
    /// so no input-file positional argument is in this vocabulary.
    fn valid_pandoc_args(resource_path: &str, out_path: &str, format: &str) -> Vec<String> {
        vec![
            "-f".into(),
            "gfm".into(),
            "--standalone".into(),
            format!("--resource-path={resource_path}"),
            "-o".into(),
            out_path.into(),
            "--pdf-engine=typst".into(),
            "-t".into(),
            format.into(),
        ]
    }

    /// A capability denial — no permission in `capabilities/default.json` grants `plugin:shell|
    /// spawn` for either sidecar at all now, so every call is rejected on the ACL itself, before
    /// any scope (`Var` regex, argument count/shape) is even consulted — always mentions "not
    /// allowed" (`tauri::ipc::authority`'s own denial messages, e.g. "… not allowed. …" or "…
    /// explicitly denied …").
    fn is_capability_denied(message: &str) -> bool {
        message.contains("not allowed") || message.contains("denied")
    }

    /// Guard: `plugin:shell|spawn` of the pandoc sidecar is denied even for a well-formed, in-
    /// vocabulary call (task 4.2's own 9-token shape) — the strongest case, since a legitimate-
    /// looking request proves the denial is unconditional, not a rejected argument shape.
    #[test]
    fn pandoc_spawn_via_plugin_shell_is_denied_with_no_shell_allow_spawn_permission() {
        let args = valid_pandoc_args("docs", "out/essay.docx", "docx");
        let args: Vec<&str> = args.iter().map(String::as_str).collect();
        let message =
            spawn_pandoc(&args).expect_err("plugin:shell|spawn of the pandoc sidecar must be denied");
        assert!(is_capability_denied(&message), "expected a capability denial, got: {message}");
    }

    /// Guard: `plugin:shell|spawn` of the typst sidecar is denied too, even for its one configured
    /// invocation (`--version`) under the capability 4.2 shipped.
    #[test]
    fn typst_spawn_via_plugin_shell_is_denied_with_no_shell_allow_spawn_permission() {
        let message = spawn_sidecar("binaries/typst", &["--version"])
            .expect_err("plugin:shell|spawn of the typst sidecar must be denied");
        assert!(is_capability_denied(&message), "expected a capability denial, got: {message}");
    }
}
