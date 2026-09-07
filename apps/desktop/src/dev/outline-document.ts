import type { Heading, Root, Yaml } from "mdast";
import { format, writeFrontMatter } from "@essaydown/core";
import type { OutlineHandoff } from "./outline-handoff.js";

/**
 * A question in `/dev/outline`'s flat list. Order in the array *is* document order: a nested
 * question sits right after the last top-level question at or before it, so nesting is a flag,
 * never a move. `depth 0` becomes an H2, `depth 1` an H3 — the task text names only those two
 * levels, so there is no third.
 */
export interface OutlineQuestion {
  readonly id: string;
  readonly text: string;
  readonly depth: 0 | 1;
}

/**
 * The topic question plus the outline turned into the document `/dev/editor` opens: one heading
 * per question, each heading's text the question's own text, and nothing else — the muted hint
 * line the task text also asks for is not Markdown (§6.1's front matter owns exactly `title` and
 * `question`), so it travels beside the Markdown as {@link OutlineHandoff.hints} instead.
 *
 * The front-matter block starts empty and `writeFrontMatter` fills the one key this route owns;
 * every failure branch it can return needs either a value with a line break (impossible — the
 * topic field is a single-line `<input>`) or a block this function did not just create, so `ok`
 * is always true here. Asserting it (rather than silently falling back to the unwritten root)
 * keeps that compiler-forced narrowing honest per CLAUDE.md.
 */
export function buildOutlineDocument(
  topic: string,
  questions: readonly OutlineQuestion[],
): OutlineHandoff {
  const headings: Heading[] = questions.map((question) => ({
    type: "heading",
    depth: question.depth === 0 ? 2 : 3,
    children: [{ type: "text", value: question.text }],
  }));
  const yaml: Yaml = { type: "yaml", value: "" };
  const root: Root = { type: "root", children: [yaml, ...headings] };

  const written = writeFrontMatter(root, { question: topic });
  if (!written.ok) {
    throw new Error(
      `buildOutlineDocument: unreachable — writeFrontMatter refused (${written.reason})`,
    );
  }

  return { markdown: format(written.root), hints: questions.map((question) => question.text) };
}
