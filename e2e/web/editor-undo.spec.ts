import { expect, test, type Page } from "@playwright/test";

/**
 * Task 1.6's acceptance: the document store's undo stack, driven from a real browser on the dev
 * route `/dev/editor`.
 *
 * The store is what is being read here, not the editor: the Markdown pane serialises the store's
 * current snapshot, so an assertion about it is an assertion about which snapshot Cmd/Ctrl+Z left
 * showing. `packages/editor/test/store.test.ts` is the headless half, where the binding and the
 * keymaps are covered with an injected clock; this file is the half that proves the chord reaches
 * the store through a real `keydown` and that the 1 s coalescing window is measured against a real
 * wall clock.
 *
 * Six assertions, one per acceptance clause: three words then undo (2), two bursts a second and a
 * half apart then undo (3), and the redo that restores the second burst (1).
 */

/** The coalescing window is 1 s (PRD §6.5), so the pause between two bursts has to exceed it. */
const PAUSE_MS = 1_500;

async function openBlankEditor(page: Page): Promise<void> {
  await page.goto("/dev/editor");
  await page.locator(".ProseMirror").click();
  await page.waitForFunction(
    () => document.querySelector('[data-testid="markdown"]')?.textContent === "",
  );
}

/** The Markdown the store currently holds. */
function markdown(page: Page): Promise<string | null> {
  return page.getByTestId("markdown").textContent();
}

test.describe("store-level undo on /dev/editor", () => {
  test("one burst: three words typed quickly are one undo step", async ({ page }) => {
    await openBlankEditor(page);
    await page.keyboard.type("one two three", { delay: 10 });
    await expect.poll(() => markdown(page)).toBe("one two three\n");

    await page.keyboard.press("ControlOrMeta+z");
    await expect.poll(() => markdown(page)).toBe("");
  });

  test("two bursts: a pause splits them, and undo takes back only the second", async ({ page }) => {
    await openBlankEditor(page);
    await page.keyboard.type("first", { delay: 10 });
    await expect.poll(() => markdown(page)).toBe("first\n");

    await page.waitForTimeout(PAUSE_MS);
    await page.keyboard.type(" second", { delay: 10 });
    await expect.poll(() => markdown(page)).toBe("first second\n");

    await page.keyboard.press("ControlOrMeta+z");
    await expect.poll(() => markdown(page)).toBe("first\n");

    await page.keyboard.press("ControlOrMeta+Shift+z");
    await expect.poll(() => markdown(page)).toBe("first second\n");
  });
});
