/**
 * Picks the WebdriverIO Tauri-service driver provider for the shell e2e harness (task 2.1.g1,
 * repair of 2.1h's GATE-FAILED windows-latest leg). Root cause (actions/runner-images#14738): on
 * that runner image's WebView2 >= 152, the browser process no longer takes
 * `--remote-debugging-port` from `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` when the app sets
 * `AdditionalBrowserArguments` through the API, which wry always does — so the
 * tauri-driver -> msedgedriver route cannot create a session on win32 at all. `darwin` has no
 * external WebDriver for WKWebView to begin with. Both platforms use the embedded provider
 * (tauri-plugin-wdio-webdriver), which spawns the app directly and never opens a remote-debugging
 * port; `linux` keeps the external route (tauri-driver + WebKitWebDriver under xvfb, CLAUDE.md).
 *
 * `override`, when given, wins on every platform for both of its two valid values — this is how
 * the container (which reports `linux`) exercises the embedded leg too. Any other override value
 * is a configuration mistake, not a platform to guess at, so it throws.
 */
export type DriverProvider = "embedded" | "external";

export function selectDriverProvider(
  platform: string,
  override: string | undefined,
): DriverProvider {
  if (override !== undefined) {
    if (override !== "embedded" && override !== "external") {
      throw new Error(
        `ESSAYDOWN_E2E_DRIVER must be "embedded" or "external", got ${JSON.stringify(override)}`,
      );
    }
    return override;
  }
  return platform === "linux" ? "external" : "embedded";
}
