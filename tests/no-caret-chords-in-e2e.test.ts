import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * DECISIONS #022 and #review-1-r3 I6 (task 1.38): an e2e case places the rendered caret only by
 * motions Blink decides by itself — arrow keys, or a click at a computed point — never by a Home
 * or End key and never by a modifier chord with one. A contenteditable resolves those through the
 * OS's key-binding layer (Cocoa scrolls on Home and End; its document motion is a Cmd+Arrow), so a
 * case that presses them is green in the Linux container and on two CI runners by accident and
 * proves nothing on the third (the 1.verify.r3h gate, red on macos-latest alone). The rule is
 * stated in `e2e/web/editor-mark-edge.spec.ts`'s doc comment; a comment is not a test — this file,
 * in the shape of `packages/editor/test/no-codemirror-history.test.ts`, is what fails the build on
 * a new use. It reads the files the property depends on, every `.ts` under `e2e/web/` counted
 * from the directory (never a literal file list), and checks each one.
 *
 * A bare Home or End press is allowed at exactly the sites in `ALLOWED_BARE_PRESSES`, all in the
 * **source** view, where the key is CodeMirror's own keymap (`standardKeymap`: line start, line
 * end), handled in JS before the OS layer sees it. The counts are exact, so a fourth use fails and
 * so does a site that moved out of its file without this list following it.
 */

const e2eWebDir = join(dirname(fileURLToPath(import.meta.url)), "..", "e2e", "web");

/** Directories under `e2e/web/` that hold no spec of ours (installs and Playwright's own output). */
const SKIPPED_DIRS = new Set(["node_modules", "playwright-report", "test-results"]);

/** A modifier chord with Home or End: the construct #022 removed. */
const CHORD = /\b(ControlOrMeta|Control|Meta)\+(Home|End)\b/g;

/** A bare Home or End key name as `keyboard.press` takes it. */
const BARE_PRESS = /"(Home|End)"/g;

/**
 * The allowed bare presses, per file (relative to `e2e/web/`), with the number of sites and the
 * reason each is not a member of the rendered-view class.
 */
const ALLOWED_BARE_PRESSES: Record<string, { count: number; reason: string }> = {
  "editor-cursor.spec.ts": {
    count: 1,
    reason:
      "source view (`toColumn`, a Home press in `.cm-content`): CodeMirror's keymap handles the key in JS before the OS layer",
  },
  "editor-toggle.spec.ts": {
    count: 2,
    reason:
      "source view (two End presses after a `.cm-content` click): CodeMirror's keymap handles the key in JS before the OS layer",
  },
};

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

function count(text: string, pattern: RegExp): number {
  return [...text.matchAll(pattern)].length;
}

describe("the e2e/web directory was read, not listed", () => {
  it("holds at least one spec file", () => {
    expect(files.length).toBeGreaterThan(0);
    expect(files.some((file) => file.endsWith(".spec.ts"))).toBe(true);
  });

  it("holds every file the allowlist names, so an allowed site cannot outlive its file", () => {
    for (const file of Object.keys(ALLOWED_BARE_PRESSES)) {
      expect(files).toContain(file);
    }
  });
});

describe("no e2e/web file places the caret with a modifier chord on Home or End", () => {
  for (const [file, text] of contents) {
    it(`${file} has no ControlOrMeta, Control or Meta chord with Home or End`, () => {
      expect(count(text, CHORD)).toBe(0);
    });
  }
});

describe("a bare Home or End press appears only at the allowlisted source-view sites", () => {
  for (const [file, text] of contents) {
    const allowed = ALLOWED_BARE_PRESSES[file];
    if (allowed === undefined) {
      it(`${file} has no bare Home or End press`, () => {
        expect(count(text, BARE_PRESS)).toBe(0);
      });
    } else {
      it(`${file} has exactly ${allowed.count} bare press(es) — ${allowed.reason}`, () => {
        expect(count(text, BARE_PRESS)).toBe(allowed.count);
      });
    }
  }
});
