import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function linesBelowFirst(path: string): string {
  return readFileSync(join(root, path), "utf8").split("\n").slice(1).join("\n");
}

describe("agent rules", () => {
  it("CLAUDE.md and AGENTS.md are identical below line 1", () => {
    expect(linesBelowFirst("AGENTS.md")).toBe(linesBelowFirst("CLAUDE.md"));
  });
});
