import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * DECISIONS #review-1-r0 F7 (task 1.19): `store.ts` and `source.ts` each carry a comment
 * asserting that `@codemirror/commands` (CodeMirror's `history`) never reaches this package, so
 * PRD §6.5's single undo stack cannot be bypassed. A comment is not a test — this one reads the
 * two files the property actually depends on, the package manifest and the workspace lockfile's
 * `packages/editor` importer, rather than re-deriving the claim from source code.
 */

const editorDir = fileURLToPath(new URL("..", import.meta.url));
const packageJson = JSON.parse(readFileSync(`${editorDir}/package.json`, "utf8")) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};
const lockfile = readFileSync(`${editorDir}/../../pnpm-lock.yaml`, "utf8");

const banned = ["codemirror", "@codemirror/commands", "prosemirror-history"];

describe("packages/editor manifest excludes CodeMirror's and ProseMirror's built-in histories", () => {
  for (const name of banned) {
    it(`${name} is absent from dependencies`, () => {
      expect(packageJson.dependencies).not.toHaveProperty(name);
    });

    it(`${name} is absent from devDependencies`, () => {
      expect(packageJson.devDependencies).not.toHaveProperty(name);
    });
  }
});

describe("pnpm-lock.yaml's packages/editor importer resolves no history package", () => {
  // The importer block runs from its own heading to the next line at the same two-space
  // indent (the next importer, or the top-level `packages:` heading that starts the resolved
  // package list) — the same shape every importer block in the file has.
  const lines = lockfile.split("\n");
  const start = lines.findIndex((line) => line === "  packages/editor:");
  if (start === -1) {
    throw new Error("pnpm-lock.yaml has no packages/editor importer block");
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\s{0,2}\S/.test(lines[i]) && lines[i] !== "") {
      end = i;
      break;
    }
  }
  const importerBlock = lines.slice(start, end).join("\n");

  it("the importer block was found and is non-empty", () => {
    expect(importerBlock.length).toBeGreaterThan(0);
  });

  for (const name of banned) {
    it(`${name} does not appear in the packages/editor importer block`, () => {
      // A bare word-boundary match: "codemirror" must not match inside "@codemirror/lang-markdown"
      // (a real, wanted dependency), so the char before and after the name is checked too.
      const escaped = name.replace(/[/@-]/g, "\\$&");
      const pattern = new RegExp(`(?<![\\w@-])${escaped}(?![\\w-])`);
      expect(importerBlock).not.toMatch(pattern);
    });
  }
});
