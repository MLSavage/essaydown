import { expect, test } from "@playwright/test";

/**
 * Task 1.8's acceptance: `/dev/outline`'s topic field, add/nest/drag list, and "Produce" button.
 *
 * Only nest and Produce are exercised here (drag reordering is `dnd-kit/sortable`'s own,
 * already-tested behaviour, PRD §4) — the acceptance sentence is "enter 3 questions, nest one,
 * click Produce", and the two things this spec can check that nothing headless can are: a real
 * navigation to `/dev/editor` happened, and the produced document's canonical Markdown and hint
 * lines are what `/dev/editor` shows once it gets there.
 */
test("outline: three questions, one nested, Produce opens /dev/editor with the built document", async ({
  page,
}) => {
  await page.goto("/dev/outline");

  await page.getByTestId("topic").fill("What is essay down?");

  for (const text of ["Q1", "Q2", "Q2a"]) {
    await page.getByTestId("question-draft").fill(text);
    await page.getByTestId("add-question").click();
  }

  const rows = page.getByTestId("outline-question");
  await expect(rows).toHaveCount(3);
  await rows.filter({ hasText: "Q2a" }).getByTestId("nest").click();
  await expect(rows.filter({ hasText: "Q2a" })).toHaveAttribute("data-depth", "1");

  await page.getByTestId("produce").click();
  await page.waitForURL("**/dev/editor");

  const markdown = await page.getByTestId("markdown").textContent();
  expect(markdown).toBe("---\nquestion: What is essay down?\n---\n\n## Q1\n\n## Q2\n\n### Q2a\n");

  const hints = page.locator(".question-hint");
  await expect(hints).toHaveCount(3);
  await expect(hints.nth(0)).toBeVisible();
  await expect(hints.nth(1)).toBeVisible();
  await expect(hints.nth(2)).toBeVisible();
  await expect(hints.nth(0)).toHaveText("Q1");
  await expect(hints.nth(1)).toHaveText("Q2");
  await expect(hints.nth(2)).toHaveText("Q2a");
});

/**
 * Task 1.18 (DECISIONS #review-1-r0 F6): a topic a YAML core-schema resolver would read back
 * typed must come out of `writeFrontMatter` quoted, and a question with the same text is
 * unaffected — a heading's hint is never mdast front matter, so it stays the literal string.
 */
test("outline: a topic a YAML reader would resolve as a boolean is produced quoted", async ({
  page,
}) => {
  await page.goto("/dev/outline");

  await page.getByTestId("topic").fill("true");
  await page.getByTestId("question-draft").fill("true");
  await page.getByTestId("add-question").click();

  await page.getByTestId("produce").click();
  await page.waitForURL("**/dev/editor");

  const markdown = await page.getByTestId("markdown").textContent();
  expect(markdown).toBe('---\nquestion: "true"\n---\n\n## true\n');

  const hints = page.locator(".question-hint");
  await expect(hints).toHaveCount(1);
  await expect(hints.nth(0)).toHaveText("true");
});
