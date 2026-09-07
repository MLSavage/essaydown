import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

/**
 * Task 1.3's acceptance: the Typora-style input rules and keymap, typed as keystrokes into a blank
 * document on the dev route `/dev/editor` and read back as the canonical Markdown the document
 * serialises to.
 *
 * The scenario table lives in `fixtures/editor/input-scenarios.json` rather than in this file, so
 * that the headless Vitest run in `packages/editor/test/input.test.ts` — which is where the plugin
 * code is covered — types the same scripts and asserts the same strings as this one. This file is
 * the half that proves the rules survive a real browser and a real `prosemirror-view`: the
 * keystrokes here are dispatched as key events, not as command calls.
 */
type Keystroke = { type: string } | { press: string };

interface Scenario {
  name: string;
  keys: Keystroke[];
  markdown: string;
}

const { scenarios } = JSON.parse(
  readFileSync(new URL("../../fixtures/editor/input-scenarios.json", import.meta.url), "utf8"),
) as { scenarios: Scenario[] };

async function openBlankEditor(page: Page): Promise<void> {
  await page.goto("/dev/editor");
  const editor = page.locator(".ProseMirror");
  await editor.click();
  await expect.poll(() => page.getByTestId("markdown").textContent()).toBe("");
}

test.describe("input rules and keymap on /dev/editor", () => {
  test("the acceptance types the 22 scenarios of the task", () => {
    expect(scenarios).toHaveLength(22);
  });

  for (const scenario of scenarios) {
    test(scenario.name, async ({ page }) => {
      await openBlankEditor(page);
      for (const key of scenario.keys) {
        if ("type" in key) await page.keyboard.type(key.type, { delay: 10 });
        else await page.keyboard.press(key.press);
      }
      await expect.poll(() => page.getByTestId("markdown").textContent()).toBe(scenario.markdown);
    });
  }
});
