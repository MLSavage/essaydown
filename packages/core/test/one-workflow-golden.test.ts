import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Paragraph, Root, Text } from "mdast";
import { describe, expect, it } from "vitest";
import { format } from "../src/format.js";
import { parse } from "../src/parse.js";
import { blocksOf } from "../src/blocks.js";
import { applyNewQuestion, applySetQuestion } from "../src/outline.js";
import { applyAddVariant, applyUseVariant } from "../src/rewrite.js";
import { applyReorderSentences, emptySidecar, type DocumentState } from "../src/sidecar.js";

// Task 3.6's golden: PRD §3 steps 1–6 (open folder, outline 3 questions, produce 2 paragraphs
// under each, rewrite one sentence, reorder two sentences, toggle source and back) starting from
// a fresh `new_file`-shaped document, `# Untitled-1\n` (apps/desktop/src-tauri/src/workspace.rs's
// `new_file_at`). Pinned here, as task 3.5's reorder-goldens.test.ts pins its own two goldens, so
// a core change that moves these bytes is caught by `pnpm test` and not only by
// e2e/shell/test/one-workflow.spec.ts.
//
// Produce's two paragraphs under each heading are plain typing — no core mutation exists for
// "insert a paragraph after a block" because Produce mode never calls one (PRD §6.3: the editor's
// own `splitBlock` does it) — so they are spliced into the tree directly here, by mdast shape
// alone; every sentence below is plain ASCII with no Markdown-special character, so this is the
// same bytes `format` would give the editor's own paragraph nodes. Toggling to source and back
// (step 6, PRD §146's Cmd/Ctrl+/ toggle, task 3.19) is not a store mutation — `toggleMode` only
// closes the coalescing group and swaps the mounted view (apps/desktop/src/workspace/
// DocumentPane.tsx) — and so has no step here either; the golden is the state after step 5.
const FIXTURES = fileURLToPath(new URL("../../../fixtures/markdown", import.meta.url));
const GOLDEN = readFileSync(`${FIXTURES}/expected/one-workflow.md`, "utf8");

const TOPIC_QUESTIONS = [
  "How did a dip pen work?",
  "What changed with metal nibs?",
  "What do readers take from it?",
] as const;
const BODIES = [
  [
    "Dip pens held thin ink. A writer paused often to reload.",
    "Metal came later and changed the touch. Writers noticed the point glide more.",
  ],
  [
    "A nib made of metal lasts longer. It holds a point for many days.",
    "Writers liked the steadier line it drew. Fewer blots showed on the page.",
  ],
  [
    "This piece argues that choices shape habits. A slight change in nib wear altered daily writing.",
    "Minor habits build up over time. A single choice can change a whole page.",
  ],
] as const;
const REWRITE_VARIANT = "A writer halted often to reload.";
const CREATED_AT = "2026-10-05T00:00:00.000Z";

function paragraph(text: string): Paragraph {
  return { type: "paragraph", children: [{ type: "text", value: text } as Text] };
}

function headingIndices(root: Root): number[] {
  return root.children.flatMap((node, index) => (node.type === "heading" ? [index] : []));
}

/** Splice `nodes` in right after root child `at` — the shape a `splitBlock` Enter plus typing
 * leaves behind, for plain text with no mark. */
function insertAfter(root: Root, at: number, nodes: readonly Paragraph[]): Root {
  const children = [...root.children];
  children.splice(at + 1, 0, ...nodes);
  return { ...root, children };
}

function workflowState(): DocumentState {
  let state: DocumentState = { root: parse("# Untitled-1\n"), sidecar: emptySidecar() };

  // Step 2 (Outline): the topic question, then 3 supporting questions — the existing H1 and two
  // appended by "New question" (applyNewQuestion always appends at the document's end).
  state = applySetQuestion(state, 0, TOPIC_QUESTIONS[0]);
  state = applyNewQuestion(state, TOPIC_QUESTIONS[1]);
  state = applyNewQuestion(state, TOPIC_QUESTIONS[2]);

  // Step 3 (Produce): 2 paragraphs under each of the 3 headings, in document order.
  for (const [index, body] of BODIES.entries()) {
    const at = headingIndices(state.root)[index];
    state = { root: insertAfter(state.root, at, body.map(paragraph)), sidecar: state.sidecar };
  }

  // Step 4 (Rewrite): one variant on the first paragraph's second sentence, chosen.
  const firstParagraph = headingIndices(state.root)[0] + 1;
  state = applyAddVariant(state, [firstParagraph, 1], REWRITE_VARIANT, CREATED_AT);
  state = applyUseVariant(state, [firstParagraph, 1], 0, CREATED_AT);

  // Step 5 (Reorder): swap the last paragraph's two sentences.
  const lastParagraph = state.root.children.length - 1;
  const blockId = (blocksOf(state.root).find((one) => one.path.length === 1 && one.path[0] === lastParagraph) as {
    contentId: string;
  }).contentId;
  state = applyReorderSentences(state, blockId, [1, 0]);

  // Step 6 (toggle source, toggle back): a read-only view, not a store mutation — no step here.
  return state;
}

describe("expected/one-workflow.md (task 3.6)", () => {
  it("PRD §3 steps 1–6 from a fresh new_file document produce the golden", () => {
    expect(format(workflowState().root)).toBe(GOLDEN);
  });
});
