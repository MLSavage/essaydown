//! No production code: the `shell:allow-spawn` scope itself lives entirely in
//! `capabilities/default.json` (task 4.2), validated by `tauri-plugin-shell`'s own scope engine.
//! This module only hosts the cargo test that drives that scope through real IPC (the same
//! `tauri::test::MockRuntime` + `get_ipc_response` pattern `commands::tests` uses), so a change to
//! the capability file is exercised against the exact ACL `run()` ships, not a hand-rolled copy of
//! the regex rules. This ACL governs only the webview-facing `plugin:shell|spawn` IPC command (no
//! `@tauri-apps/plugin-shell` import exists under `apps/desktop/src`, so the frontend never calls
//! it) — `export.rs`'s own Rust-side `ShellExt::sidecar`/`Command::spawn` route to `pandoc` never
//! consults it at all (confirmed by reading the installed `tauri-plugin-shell` 2.3.6 crate), so
//! 4.18's `PATH` prepend on the Rust-side pandoc `Command` needs no capability change here.

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

    /// A scope rejection (a failed `Var` regex, a missing argument, or an unexpected shape) always
    /// mentions "regex validation", "not found" or "unexpected format" (`scope::Error`'s own
    /// `Validation`/`MissingVar`/`InvalidInput` messages); a *resolvable* call that the scope
    /// accepted but this mock test environment cannot actually launch (no bundled sidecar
    /// directory exists here) instead fails with "failed to create the path to the command"
    /// (`scope::Error::Sidecar`) — a different failure, at a later stage, proving the args
    /// themselves passed scope validation.
    fn is_scope_rejection(message: &str) -> bool {
        message.contains("regex validation")
            || message.contains("was not found")
            || message.contains("unexpected format")
            || message.contains("not found")
    }

    #[test]
    fn a_well_formed_docx_export_call_passes_scope_validation() {
        let args = valid_pandoc_args("docs", "out/essay.docx", "docx");
        let args: Vec<&str> = args.iter().map(String::as_str).collect();
        let result = spawn_pandoc(&args);
        if let Err(message) = result {
            assert!(
                !is_scope_rejection(&message),
                "a well-formed call must not be rejected by the scope, got: {message}"
            );
        }
    }

    #[test]
    fn a_well_formed_pdf_export_call_passes_scope_validation() {
        let args = valid_pandoc_args(".", "out/essay.pdf", "pdf");
        let args: Vec<&str> = args.iter().map(String::as_str).collect();
        let result = spawn_pandoc(&args);
        if let Err(message) = result {
            assert!(
                !is_scope_rejection(&message),
                "a well-formed call must not be rejected by the scope, got: {message}"
            );
        }
    }

    /// A `--lua-filter` smuggled into the `-t` format slot (the one value pandoc actually reads
    /// from an attacker-reachable field) must fail the format validator — pandoc Lua filters run
    /// arbitrary Lua, so this is the exact class of argument the scope exists to stop at the format
    /// position, not just at `--resource-path`/`-o`.
    #[test]
    fn lua_filter_smuggled_as_the_format_value_is_rejected() {
        let args = valid_pandoc_args("docs", "out/essay.html", "--lua-filter=evil.lua");
        let args: Vec<&str> = args.iter().map(String::as_str).collect();
        let message = spawn_pandoc(&args).expect_err("a --lua-filter format value must be rejected");
        assert!(is_scope_rejection(&message), "expected a scope rejection, got: {message}");
    }

    #[test]
    fn an_absolute_resource_path_outside_the_workspace_is_rejected() {
        let args = valid_pandoc_args("/etc", "out/essay.html", "html");
        let args: Vec<&str> = args.iter().map(String::as_str).collect();
        let message =
            spawn_pandoc(&args).expect_err("an absolute --resource-path must be rejected");
        assert!(is_scope_rejection(&message), "expected a scope rejection, got: {message}");
    }

    #[test]
    fn a_traversal_resource_path_outside_the_workspace_is_rejected() {
        let args = valid_pandoc_args("../../etc", "out/essay.html", "html");
        let args: Vec<&str> = args.iter().map(String::as_str).collect();
        let message =
            spawn_pandoc(&args).expect_err("a `..`-traversal --resource-path must be rejected");
        assert!(is_scope_rejection(&message), "expected a scope rejection, got: {message}");
    }

    #[test]
    fn an_absolute_output_path_outside_the_workspace_is_rejected() {
        let args = valid_pandoc_args("docs", "/etc/passwd", "html");
        let args: Vec<&str> = args.iter().map(String::as_str).collect();
        let message = spawn_pandoc(&args).expect_err("an absolute -o path must be rejected");
        assert!(is_scope_rejection(&message), "expected a scope rejection, got: {message}");
    }

    #[test]
    fn a_traversal_output_path_outside_the_workspace_is_rejected() {
        let args = valid_pandoc_args("docs", "../../etc/passwd", "html");
        let args: Vec<&str> = args.iter().map(String::as_str).collect();
        let message = spawn_pandoc(&args).expect_err("a `..`-traversal -o path must be rejected");
        assert!(is_scope_rejection(&message), "expected a scope rejection, got: {message}");
    }

    /// `typst`'s only configured invocation is a bare `--version`, so this is also where the
    /// "nothing else" clause of the scope is pinned: any other argument is rejected.
    #[test]
    fn typst_version_check_passes_scope_validation() {
        let result = spawn_sidecar("binaries/typst", &["--version"]);
        if let Err(message) = result {
            assert!(
                !is_scope_rejection(&message),
                "typst --version must not be rejected by the scope, got: {message}"
            );
        }
    }

    #[test]
    fn typst_called_with_anything_other_than_version_is_rejected() {
        let message = spawn_sidecar("binaries/typst", &["compile", "doc.typ"])
            .expect_err("typst must only ever be called with --version");
        assert!(is_scope_rejection(&message), "expected a scope rejection, got: {message}");
    }
}
