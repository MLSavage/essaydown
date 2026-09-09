import { expect, test, type Page } from "@playwright/test";

/**
 * Task 1.5's acceptance: `/dev/source` renders the essay fixture through the CodeMirror source
 * view, and each of the 7 `essaydown-tok-*` classes (`source.ts`'s module comment names why the
 * stock `lang-markdown` highlighting collapses them onto one tag) resolves to its own computed
 * color, in both `prefers-color-scheme` themes — 14 assertions, one per class per theme.
 *
 * The colors live in `source.css` as bare class selectors with no ancestor scoping. Task 1.21 F9d
 * (DECISIONS #review-1-r0): the previous version of this file measured every class on a probe span
 * it appended to `document.body` itself, so a highlighter that assigned no class at all — a real
 * regression in `source.ts`'s `styleTags` rule — stayed green, because the probe never asked
 * CodeMirror to classify anything. `essay-fixture.md` produces 6 of the 7 classes live (checked
 * against the fixture's own text: `##`/`###` headings, an `![alt](url)` image for `link`, a fenced
 * code block for `code`, a `>` blockquote, `-`/`1.` list markers, and two `| --- |` tables), so
 * those 6 are measured on a real `.cm-content .essaydown-tok-<name>` node CodeMirror rendered.
 * Emphasis is the one class the fixture has no run of at all (no `*text*` or `_text_` outside a
 * fenced code block), so it keeps the probe-span fallback, which is honest for that one case only.
 */

const CLASSES = [
  "essaydown-tok-heading",
  "essaydown-tok-emphasis",
  "essaydown-tok-link",
  "essaydown-tok-code",
  "essaydown-tok-blockquote",
  "essaydown-tok-list-marker",
  "essaydown-tok-table-delimiter",
] as const;

/** The one class the fixture produces no live node for; see the module comment. */
const PROBE_ONLY = "essaydown-tok-emphasis";

/**
 * The computed `color` of each of the 7 classes, on the current page: a real highlighted node in
 * `.cm-content` for the 6 classes the fixture produces, a bare probe span for emphasis alone.
 *
 * CodeMirror virtualizes `.cm-content` against the page's own scroll position — this dev route's
 * host is sized by CSS so it never grows its own internal scrollbar (`overflow: auto` on a box
 * whose height is otherwise content-driven) — so a class whose only occurrence is far down the
 * ~3,500 px document is not in the DOM until the page scrolls there, and no single scroll position
 * shows all 6 at once. The loop below scrolls the window in fixed steps, recording each class's
 * color the first time a real node for it is attached, until every class the fixture produces has
 * been found or the bottom of the page is reached.
 */
async function tokenColors(page: Page): Promise<Record<(typeof CLASSES)[number], string>> {
  await page.goto("/dev/source");
  await page.waitForSelector(".cm-content");
  const found = await page.evaluate(
    async ({ classes, probeOnly }) => {
      const result: Record<string, string> = {};
      const wanted = classes.filter((cls) => cls !== probeOnly);
      let lastY = -1;
      for (let y = 0; ; y += 350) {
        window.scrollTo(0, y);
        // Two rAFs: CodeMirror's viewport plugin re-measures on the frame after the scroll event.
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        for (const cls of wanted) {
          if (cls in result) continue;
          const node = document.querySelector(`.cm-content .${cls}`);
          if (node !== null) result[cls] = getComputedStyle(node).color;
        }
        if (Object.keys(result).length === wanted.length) break;
        if (window.scrollY === lastY) break; // reached the bottom without finding every class
        lastY = window.scrollY;
      }
      return result;
    },
    { classes: CLASSES, probeOnly: PROBE_ONLY },
  );
  for (const cls of CLASSES) {
    if (cls === PROBE_ONLY) continue;
    expect(found[cls], `no live ${cls} node found while scrolling /dev/source`).toBeDefined();
  }

  const probeColor = await page.evaluate((probeOnly) => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const probe = document.createElement("span");
    probe.className = probeOnly;
    probe.textContent = "x";
    host.appendChild(probe);
    const color = getComputedStyle(probe).color;
    host.remove();
    return color;
  }, PROBE_ONLY);

  return { ...found, [PROBE_ONLY]: probeColor } as Record<(typeof CLASSES)[number], string>;
}

/** Each class's color must not collide with any of the other 6, in the given theme. */
function assertAllDistinct(colors: Record<string, string>): void {
  const values = CLASSES.map((cls) => colors[cls]);
  for (const cls of CLASSES) {
    expect(values.filter((color) => color === colors[cls])).toHaveLength(1);
  }
}

test.describe("source view 7-token color theme, on /dev/source", () => {
  test("light mode: each of the 7 token classes has a distinct computed color", async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: "light" });
    const colors = await tokenColors(page);
    assertAllDistinct(colors);
  });

  test("dark mode: each of the 7 token classes has a distinct computed color", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    const colors = await tokenColors(page);
    assertAllDistinct(colors);
  });
});
