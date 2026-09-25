import assert from "node:assert/strict";

// The harness bring-up smoke test (task 2.1): proves the real Tauri window launches under
// WebdriverIO + tauri-driver and the React bundle it loads is the one this repo built, not that
// any particular feature works. Byte-exact assertions only (DECISIONS #022's rule for the
// rendered view), never a normalising matcher.
describe("the shell smoke spec", () => {
  it("launches the Tauri window and renders the app's own document title", async () => {
    // The webview navigates to the embedded frontend asynchronously after the session comes up;
    // poll rather than read once, the same way the web e2e suite waits out its own coalescing window.
    await browser.waitUntil(async () => (await browser.getTitle()) === "Essay Down", {
      timeout: 15000,
      timeoutMsg: "the window's document title never became \"Essay Down\"",
    });
    assert.equal(await browser.getTitle(), "Essay Down");
  });

  it("loads the React bundle, not a static shell", async () => {
    await browser.waitUntil(async () => (await browser.$("#greet-input")).isExisting(), {
      timeout: 15000,
      timeoutMsg: "#greet-input never appeared",
    });
    assert.equal(await (await browser.$("#greet-input")).isExisting(), true);
  });
});
