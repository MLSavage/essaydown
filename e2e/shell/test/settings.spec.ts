import assert from "node:assert/strict";
import { reloadPage } from "./routes.js";

// The minimal settings dialog (task 2.7): opened with Ctrl+, (Cmd/Ctrl+, — this container is
// Linux, so Ctrl), showing only the typewriterScroll toggle and, per the description, an optional
// credential-store status line — never any coach configuration (provider/base URL/model/key),
// which the acceptance's own words rule out ("Does NOT render any coach UI").
async function exists(selector: string): Promise<boolean> {
  return browser.execute((sel) => document.querySelector(sel) !== null, selector);
}

async function waitForSelector(selector: string, timeoutMsg: string): Promise<void> {
  await browser.waitUntil(async () => exists(selector), { timeout: 15000, timeoutMsg });
}

async function checkedOf(selector: string): Promise<boolean> {
  return browser.execute(
    (sel) => (document.querySelector(sel) as HTMLInputElement | null)?.checked ?? false,
    selector,
  );
}

async function openSettings(): Promise<void> {
  await browser.keys(["Control", ","]);
  await waitForSelector('[data-testid="settings-dialog"]', "settings-dialog never appeared after Ctrl+,");
}

async function closeSettings(): Promise<void> {
  await browser.keys(["Escape"]);
  await browser.waitUntil(async () => !(await exists('[data-testid="settings-dialog"]')), {
    timeout: 15000,
    timeoutMsg: "settings-dialog never closed on Escape",
  });
}

// Same "relaunch is a real process restart" reasoning as e2e/shell/test/file-tree.spec.ts: the
// webview's on-disk storage survives it the way a real relaunch's would, but only `reloadSession()`
// actually restarts the process rather than re-navigating the same one.
async function relaunch(): Promise<void> {
  try {
    await browser.reloadSession();
  } catch (error) {
    console.warn(
      `reloadSession() failed (${(error as Error).message}); falling back to a page reload — ` +
        "this only re-proves the frontend path, not a real process restart",
    );
    await reloadPage();
  }
  await waitForSelector('[data-testid="open-folder"]', '[data-testid="open-folder"] never reappeared after relaunch');
}

describe("the settings dialog (Cmd/Ctrl+,)", () => {
  it("opens on Ctrl+, and renders only the typewriter-scroll toggle, no coach UI", async () => {
    await waitForSelector('[data-testid="open-folder"]', "app shell never loaded");
    await openSettings();

    await waitForSelector(
      '[data-testid="typewriter-scroll-toggle"][data-loaded="true"]',
      "typewriter-scroll-toggle never finished loading",
    );

    const inputCount = await browser.execute(
      (sel) => document.querySelectorAll(`${sel} input`).length,
      '[data-testid="settings-dialog"]',
    );
    assert.equal(inputCount, 1, "the settings dialog must render exactly one input: the typewriter-scroll toggle");
    assert.equal(await checkedOf('[data-testid="typewriter-scroll-toggle"]'), false);

    await closeSettings();
  });

  it("typewriterScroll persists across relaunch", async () => {
    await openSettings();
    await waitForSelector(
      '[data-testid="typewriter-scroll-toggle"][data-loaded="true"]',
      "typewriter-scroll-toggle never finished loading",
    );
    await (await browser.$('[data-testid="typewriter-scroll-toggle"]')).click();
    assert.equal(await checkedOf('[data-testid="typewriter-scroll-toggle"]'), true);
    await closeSettings();

    await relaunch();

    await openSettings();
    await browser.waitUntil(async () => checkedOf('[data-testid="typewriter-scroll-toggle"]'), {
      timeout: 15000,
      timeoutMsg: "typewriter-scroll-toggle did not come back checked after relaunch",
    });
    await closeSettings();
  });
});
