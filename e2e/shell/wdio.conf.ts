import { platform } from "node:os";

// The workspace Cargo.toml has no `target-dir` override, so the build lands at the repo root
// (`<root>/target/<profile>/<bin>`), two levels above this config (docs/configuration.md's
// "Cargo workspace" case in @wdio/tauri-service's README).
const BINARY_NAME = platform() === "win32" ? "desktop.exe" : "desktop";
const appBinaryPath = `../../target/debug/${BINARY_NAME}`;

// macOS has no external WebDriver for WKWebView, so it runs the embedded provider instead:
// tauri-plugin-wdio-webdriver, registered under #[cfg(debug_assertions)] in
// apps/desktop/src-tauri/src/lib.rs, serves WebDriver from inside the app itself. Ubuntu and
// Windows drive the app through the cargo-installed tauri-driver against WebKitWebDriver /
// msedgedriver (CLAUDE.md: WebdriverIO + tauri-driver for the shell).
const driverProvider = platform() === "darwin" ? "embedded" : "external";

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
        autoDownloadEdgeDriver: true,
      },
    ],
  ],
  capabilities: [
    {
      browserName: "tauri",
    },
  ],
  logLevel: "info",
  framework: "mocha",
  reporters: ["spec"],
  mochaOpts: {
    ui: "bdd",
    timeout: 60000,
  },
};
