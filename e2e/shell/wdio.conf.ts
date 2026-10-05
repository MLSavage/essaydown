import { platform } from "node:os";
import { selectDriverProvider } from "./provider.js";

// The workspace Cargo.toml has no `target-dir` override, so the build lands at the repo root
// (`<root>/target/<profile>/<bin>`), two levels above this config (docs/configuration.md's
// "Cargo workspace" case in @wdio/tauri-service's README).
const BINARY_NAME = platform() === "win32" ? "desktop.exe" : "desktop";
const appBinaryPath = `../../target/debug/${BINARY_NAME}`;

// e2e/shell/provider.ts picks the route: linux drives the app through the cargo-installed
// tauri-driver against WebKitWebDriver under xvfb (CLAUDE.md); win32 and darwin have no working
// external WebDriver route for their WebView (actions/runner-images#14738 for win32; WKWebView
// never had one), so both run the embedded provider — tauri-plugin-wdio-webdriver, registered
// under #[cfg(debug_assertions)] in apps/desktop/src-tauri/src/lib.rs, serving WebDriver from
// inside the app itself. ESSAYDOWN_E2E_DRIVER overrides the platform's default on any OS.
const driverProvider = selectDriverProvider(platform(), process.env.ESSAYDOWN_E2E_DRIVER);

export const config: WebdriverIO.Config = {
  specs: ["./test/**/*.spec.ts"],
  maxInstances: 1,
  services: [
    [
      "@wdio/tauri-service",
      {
        appBinaryPath,
        driverProvider,
        // tauri-driver is pinned (docker/versions.env TAURI_DRIVER_VERSION) and cargo-installed
        // ahead of time, both in the container image and in ci.yml; never auto-installed here.
        autoInstallTauriDriver: false,
        // The service's Edge-driver check runs on win32 regardless of driverProvider, and fails on
        // a missing driver when auto-download is off — so this stays true even though win32 no
        // longer takes the msedgedriver route for the session itself.
        autoDownloadEdgeDriver: true,
        // So a failure (a stuck embedded-provider readiness wait, an app that never becomes ready)
        // carries the app's own stderr in e2e-shell.log, not just WebdriverIO's side of it.
        captureBackendLogs: true,
      },
    ],
  ],
  capabilities: [
    {
      browserName: "tauri",
    },
  ],
  // The log writer only opens a file when this is set (otherwise captured lines go to the
  // runner's own stdout, which a spec cannot read back) — review-2-r0 U9(d)'s presence case
  // reads this directory (robustness.spec.ts), so it is set under e2e/shell/, gitignored by
  // the repo-wide `logs/` pattern.
  outputDir: "./logs",
  logLevel: "info",
  framework: "mocha",
  reporters: ["spec"],
  mochaOpts: {
    ui: "bdd",
    timeout: 60000,
  },
};
