import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Task 2.21 (DECISIONS #review-2-r0 U22 — Claude r0 finding 18; the backlog line
 * `[review-1-r3 I7]`'s own trigger, "a second occurrence → a test-only fix task"): a Playwright
 * `page.goto` of a dev route, on a Windows CI runner with a cold Vite dev server, can take long
 * enough for `.ProseMirror`'s own actionability wait (or `load()`'s `setInputFiles` on the dev
 * bar's fixture input) to exhaust the test's whole 30 s budget before the route has mounted at
 * all (`2.verify.g3h` a1: `editor-toggle.spec.ts:84`'s `.locator(".ProseMirror").click()`, the
 * same class as I7's own `editor-clipboard.spec.ts` `load()` instance).
 *
 * Scope is the `openEditor`/`load()` helpers and the spec files that call them (CLAUDE.md; the
 * task text's own words) — found here by reading the directory for a `function openEditor(` or
 * `function load(` definition, never a literal file list, so a helper renamed or moved keeps this
 * guard honest. Every `page.goto` of a dev route inside one of those files must be immediately
 * followed by a wait on the route's own mount marker (`data-testid="editor"` for `/dev/editor`,
 * already present on `DevEditor.tsx`'s host `<div>` in its first React commit, before the
 * `useEffect` that creates `.ProseMirror` runs) — read from the helper's own source text, never
 * from a runtime timing.
 */

const e2eWebDir = join(dirname(fileURLToPath(import.meta.url)), "..", "e2e", "web");

/** Directories under `e2e/web/` that hold no spec of ours (installs and Playwright's own output). */
const SKIPPED_DIRS = new Set(["node_modules", "playwright-report", "test-results"]);

/** Every `.ts` file under `dir`, recursively, as paths relative to `e2e/web/`. */
function specFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) files.push(...specFiles(path));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(relative(e2eWebDir, path));
    }
  }
  return files.sort();
}

const files = specFiles(e2eWebDir);
const contents = new Map(files.map((file) => [file, readFileSync(join(e2eWebDir, file), "utf8")]));

/** A file is in scope when it defines the `openEditor` or `load` helper (CLAUDE.md's own naming). */
function isScoped(text: string): boolean {
  return /(?:^|\s)async function openEditor\(/.test(text) || /(?:^|\s)async function load\(/.test(text);
}

const scoped = files.filter((file) => isScoped(contents.get(file) ?? ""));

/** Every `page.goto("/dev/...")` call in `text`, with its own indentation captured. */
const GOTO = /([ \t]*)await page\.goto\("(\/dev\/(?:editor|source|outline))"\);/g;

/** The mount-marker testid each dev route's page sets in its own first React commit. */
const MARKER_OF_ROUTE: Record<string, string> = {
  "/dev/editor": "editor",
  "/dev/source": "source",
  "/dev/outline": "topic",
};

/** Whether the `goto` at `matchEnd` in `text`, indented by `indent`, is immediately followed by its route's mount wait — the next non-empty line, read as text, not run. */
function gotoIsFollowedByMountWait(text: string, matchEnd: number, indent: string, route: string): boolean {
  const marker = MARKER_OF_ROUTE[route];
  const rest = text.slice(matchEnd);
  const nextLine = rest.split("\n", 2)[1] ?? "";
  const expected = `${indent}await page.getByTestId("${marker}").waitFor();`;
  return nextLine === expected;
}

describe("the e2e/web directory was read, not listed", () => {
  it("holds at least one spec file", () => {
    expect(files.length).toBeGreaterThan(0);
    expect(files.some((file) => file.endsWith(".spec.ts"))).toBe(true);
  });

  it("finds the openEditor/load() helpers by reading the files, not a hardcoded list", () => {
    expect(scoped.length).toBeGreaterThan(0);
    expect(scoped).toContain("editor-toggle.spec.ts");
    expect(scoped).toContain("editor-clipboard.spec.ts");
  });
});

describe("every dev-route goto in an openEditor/load()-scoped file waits for that route's mount marker before its first action", () => {
  for (const file of scoped) {
    const text = contents.get(file) ?? "";
    const matches = [...text.matchAll(GOTO)];
    it(`${file} has at least one dev-route goto`, () => {
      expect(matches.length).toBeGreaterThan(0);
    });
    for (const match of matches) {
      const [full, indent, route] = match;
      const matchEnd = (match.index ?? 0) + full.length;
      const line = text.slice(0, matchEnd).split("\n").length;
      it(`${file}:${line} — ${route}'s goto precedes the mount wait for "${MARKER_OF_ROUTE[route]}", not a timing`, () => {
        expect(gotoIsFollowedByMountWait(text, matchEnd, indent, route)).toBe(true);
      });
    }
  }
});
