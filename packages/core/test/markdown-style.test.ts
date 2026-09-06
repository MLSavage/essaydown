import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { format } from "../src/format.js";
import { parse } from "../src/parse.js";

const STYLE_DOC = fileURLToPath(new URL("../../../docs/MARKDOWN-STYLE.md", import.meta.url));

interface Example {
  number: number;
  title: string;
  input: string;
  output: string;
}

const HEADING = /^### Example (\d+) — (.+)$/;
const FENCE_OPEN = "~~~~markdown";
const FENCE_CLOSE = "~~~~";

/**
 * Read the examples out of docs/MARKDOWN-STYLE.md. Each `### Example n — title` section holds
 * two four-tilde blocks, the input then the expected output; a block's content is its lines
 * joined by newlines plus the single trailing newline the canonical style requires.
 */
function readExamples(doc: string): Example[] {
  const lines = doc.split("\n");
  const examples: Example[] = [];
  let current: { number: number; title: string; blocks: string[] } | null = null;

  for (let i = 0; i < lines.length; i++) {
    const heading = HEADING.exec(lines[i]);
    if (heading) {
      if (current) examples.push(finish(current));
      current = { number: Number(heading[1]), title: heading[2], blocks: [] };
      continue;
    }
    if (current && lines[i] === FENCE_OPEN) {
      const body: string[] = [];
      i++;
      while (i < lines.length && lines[i] !== FENCE_CLOSE) body.push(lines[i++]);
      if (i >= lines.length) throw new Error(`unterminated block in example ${current.number}`);
      body.push("");
      current.blocks.push(body.join("\n"));
    }
  }
  if (current) examples.push(finish(current));
  return examples;
}

function finish(current: { number: number; title: string; blocks: string[] }): Example {
  if (current.blocks.length !== 2) {
    throw new Error(`example ${current.number} has ${current.blocks.length} blocks, expected 2`);
  }
  return {
    number: current.number,
    title: current.title,
    input: current.blocks[0],
    output: current.blocks[1],
  };
}

const examples = readExamples(readFileSync(STYLE_DOC, "utf8"));

describe("docs/MARKDOWN-STYLE.md", () => {
  it("holds exactly the twelve numbered examples the style is specified by", () => {
    expect(examples.map((e) => e.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  for (const example of examples) {
    it(`example ${example.number} — ${example.title}`, () => {
      expect(format(parse(example.input))).toBe(example.output);
    });
  }
});
