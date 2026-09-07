import { expect, test, type Page } from "@playwright/test";

/**
 * Task 1.5's acceptance: `/dev/source` renders the essay fixture through the CodeMirror source
 * view, and each of the 7 `essaydown-tok-*` classes (`source.ts`'s module comment names why the
 * stock `lang-markdown` highlighting collapses them onto one tag) resolves to its own computed
 * color, in both `prefers-color-scheme` themes — 14 assertions, one per class per theme.
 *
 * The colors live in `source.css` as bare class selectors with no ancestor scoping, so a probe
 * element carrying only the class — appended to the page CodeMirror already loaded the stylesheet
 * into — reports the same computed color a real syntax-highlighted span would; this keeps the
 * test independent of which of the 7 constructs the essay fixture happens to contain (it has no
 * emphasis run at all), matching what `source.test.ts` already proves about class *assignment*.
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

/** The computed `color` of a bare probe span for each of the 7 classes, on the current page. */
async function tokenColors(page: Page): Promise<Record<(typeof CLASSES)[number], string>> {
  await page.goto("/dev/source");
  await page.waitForSelector(".cm-editor");
  return page.evaluate((classes) => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const result = {} as Record<string, string>;
    for (const cls of classes) {
      const el = document.createElement("span");
      el.className = cls;
      el.textContent = "x";
      host.appendChild(el);
      result[cls] = getComputedStyle(el).color;
    }
    host.remove();
    return result;
  }, CLASSES);
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

  test("dark mode: each of the 7 token classes has a distinct computed color", async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    const colors = await tokenColors(page);
    assertAllDistinct(colors);
  });
});
