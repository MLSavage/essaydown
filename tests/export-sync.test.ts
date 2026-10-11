import { describe, expect, it } from "vitest";
import {
  exportDocument,
  type ExportArgs,
  type ExportFlushResult,
  type ExportIO,
  type ExportOutcome,
} from "../apps/desktop/src/workspace/export-sync.js";

function fakeIO(flush: ExportFlushResult, outcome: ExportOutcome): { io: ExportIO; calls: string[]; runArgs: ExportArgs[] } {
  const calls: string[] = [];
  const runArgs: ExportArgs[] = [];
  const io: ExportIO = {
    flush: async () => {
      calls.push("flush");
      return flush;
    },
    readDoc: async (path) => {
      calls.push(`readDoc:${path}`);
      return `contents of ${path}`;
    },
    runExport: async (args) => {
      calls.push("runExport");
      runArgs.push(args);
      return outcome;
    },
    reveal: async (path) => {
      calls.push(`reveal:${path}`);
    },
  };
  return { io, calls, runArgs };
}

const CLEAN_OUTCOME: ExportOutcome = { outPath: "essay.docx", warning: null };

describe("exportDocument", () => {
  it("flushes, reads the settled bytes, exports and reveals when the pane is clean", async () => {
    const { io, calls, runArgs } = fakeIO("clean", CLEAN_OUTCOME);
    const result = await exportDocument(io, "essay.md", "essay.docx", "docx");
    expect(result).toEqual({ status: "exported", outcome: CLEAN_OUTCOME });
    expect(calls).toEqual(["flush", "readDoc:essay.md", "runExport", "reveal:essay.docx"]);
    // The fake's default bytes ("contents of essay.md") carry no front matter, so the title falls
    // back to the document's own stem (DECISIONS #review-4-r0 U1).
    expect(runArgs).toEqual([
      { path: "essay.md", outPath: "essay.docx", format: "docx", contents: "contents of essay.md", title: "essay" },
    ]);
  });

  it("flushes, reads the settled bytes, exports and reveals when the pane just saved", async () => {
    const { io, calls } = fakeIO("saved", CLEAN_OUTCOME);
    const result = await exportDocument(io, "essay.md", "essay.docx", "docx");
    expect(result).toEqual({ status: "exported", outcome: CLEAN_OUTCOME });
    expect(calls).toEqual(["flush", "readDoc:essay.md", "runExport", "reveal:essay.docx"]);
  });

  it("stops at a conflicted flush without reading, exporting or revealing", async () => {
    const { io, calls } = fakeIO("conflict", CLEAN_OUTCOME);
    const result = await exportDocument(io, "essay.md", "essay.docx", "docx");
    expect(result).toEqual({ status: "not-saved", flush: "conflict" });
    expect(calls).toEqual(["flush"]);
  });

  it("stops at a failed flush without reading, exporting or revealing", async () => {
    const { io, calls } = fakeIO("failed", CLEAN_OUTCOME);
    const result = await exportDocument(io, "essay.md", "essay.docx", "docx");
    expect(result).toEqual({ status: "not-saved", flush: "failed" });
    expect(calls).toEqual(["flush"]);
  });

  it("still reveals the output when the outcome carries a missing-image warning (lesson [4.0]: a warning, not a failure)", async () => {
    const warned: ExportOutcome = { outPath: "essay.docx", warning: "[WARNING] Could not fetch resource x.png" };
    const { io, calls } = fakeIO("clean", warned);
    const result = await exportDocument(io, "essay.md", "essay.docx", "docx");
    expect(result).toEqual({ status: "exported", outcome: warned });
    expect(calls).toContain("reveal:essay.docx");
  });

  it("reveals the outcome's own out_path, not the path it was asked to export to", async () => {
    const renamed: ExportOutcome = { outPath: "renamed-by-pandoc.html", warning: null };
    const { io, calls } = fakeIO("clean", renamed);
    await exportDocument(io, "essay.md", "essay.html", "html");
    expect(calls).toContain("reveal:renamed-by-pandoc.html");
    expect(calls).not.toContain("reveal:essay.html");
  });

  it("still reports the export as exported when reveal itself fails (task 4.4: no xdg-open in this container)", async () => {
    const { io, calls } = fakeIO("clean", CLEAN_OUTCOME);
    io.reveal = async (path) => {
      calls.push(`reveal:${path}`);
      throw new Error("No such file or directory (os error 2)");
    };
    const result = await exportDocument(io, "essay.md", "essay.docx", "docx");
    expect(result).toEqual({ status: "exported", outcome: CLEAN_OUTCOME });
    expect(calls).toEqual(["flush", "readDoc:essay.md", "runExport", "reveal:essay.docx"]);
  });

  it("sends the document's own stem as the title when the settled bytes have no front-matter title (DECISIONS #review-4-r0 U1)", async () => {
    const { io, runArgs } = fakeIO("clean", CLEAN_OUTCOME);
    io.readDoc = async () => "# Heading\n\nNo front matter here.\n";
    await exportDocument(io, "notes/essay.md", "notes/essay.docx", "docx");
    expect(runArgs[0]?.title).toBe("essay");
  });

  it("sends no title when the settled bytes already carry a front-matter title", async () => {
    const { io, runArgs } = fakeIO("clean", CLEAN_OUTCOME);
    io.readDoc = async () => "---\ntitle: My Own Title\n---\n\n# Heading\n\nBody.\n";
    await exportDocument(io, "essay.md", "essay.docx", "docx");
    expect(runArgs[0]?.title).toBeUndefined();
  });

  // Two rows carry no `title` line at all, so no shape below has anything to vary; each is its own
  // single check rather than a row of the shape matrix.
  it.each([
    ["no front matter", "# Heading\n\nBody.\n"],
    ["a block without title", "---\nquestion: What now?\n---\n\n# Heading\n\nBody.\n"],
  ] as const)("%s: the IPC receives the stem", async (_name, source) => {
    const { io, runArgs } = fakeIO("clean", CLEAN_OUTCOME);
    io.readDoc = async () => source;
    await exportDocument(io, "essay.md", "essay.docx", "docx");
    expect(runArgs[0]?.title).toBe("essay");
  });

  // One row per front-matter `title` spelling (DECISIONS #review-4-r1 finding 1), each the single
  // physical line (or lines, for the two multi-line rows) the key's own value occupies, and the
  // expected IPC title: the stem for every spelling pandoc would not read as a non-empty title,
  // `undefined` for every spelling it would — the same rows `hasPandocReadableTitle` enumerates in
  // packages/core/test/front-matter-grammar.test.ts.
  const TITLE_ROWS: readonly (readonly [string, readonly string[], string | undefined])[] = [
    ["title:", ["title:"], "essay"],
    ['title: ""', ['title: ""'], "essay"],
    ["title: ''", ["title: ''"], "essay"],
    ["title: '  '", ["title: '  '"], "essay"],
    ["title: # c", ["title: # c"], "essay"],
    ["title: ~", ["title: ~"], "essay"],
    ["title: null", ["title: null"], "essay"],
    ["title: NULL", ["title: NULL"], "essay"],
    ["title: []", ["title: []"], "essay"],
    ["title: {}", ["title: {}"], "essay"],
    ["title: My Own Title", ["title: My Own Title"], undefined],
    ['title: "null"', ['title: "null"'], undefined],
    ["title: 42", ["title: 42"], undefined],
    ["title: true", ["title: true"], undefined],
    ["title: [a]", ["title: [a]"], undefined],
    ["title: {text: X}", ["title: {text: X}"], undefined],
    ["title: |- then a block scalar", ["title: |-", "  Block"], undefined],
    ["a two-line plain continuation", ["title: Line one", "  continued"], undefined],
  ];

  // Three block shapes (DECISIONS #review-4-r2): the key alone (the shape above tested); beside a
  // sibling key the app's grammar refuses outright (`tags:` then a column-0 compact sequence,
  // which makes the whole block malformed) — a neighbour line that used to erase every key's value
  // with it; and the key itself spelled with quotes, which the app's writer cannot address and
  // reads through a different route entirely (sidecar.ts's quoted-key branch). A row whose value
  // spans more than one physical line (the block scalar and the continuation) has no quoted-key
  // form worth asserting new behaviour for — this writer's quoted-key route never looks at
  // continuation at all — so that shape skips those two rows.
  const SHAPES: readonly {
    readonly name: string;
    readonly build: (titleLines: readonly string[]) => string | null;
  }[] = [
    {
      name: "the key alone",
      build: (titleLines) => `---\n${titleLines.join("\n")}\n---\n\n# Heading\n\nBody.\n`,
    },
    {
      name: "beside tags: then - essay",
      build: (titleLines) => `---\n${titleLines.join("\n")}\ntags:\n- essay\n---\n\n# Heading\n\nBody.\n`,
    },
    {
      name: 'the key spelled "title"',
      build: (titleLines) => {
        if (titleLines.length > 1) return null;
        const quoted = titleLines[0].replace(/^title:/, '"title":');
        return `---\n${quoted}\n---\n\n# Heading\n\nBody.\n`;
      },
    },
  ];

  it.each(
    SHAPES.flatMap((shape) =>
      TITLE_ROWS.map(([name, titleLines, expected]) => [shape.name, name, shape.build(titleLines), expected] as const),
    ).filter(([, , source]) => source !== null),
  )("%s, %s: the IPC receives title %j", async (_shape, _name, source, expected) => {
    const { io, runArgs } = fakeIO("clean", CLEAN_OUTCOME);
    io.readDoc = async () => source as string;
    await exportDocument(io, "essay.md", "essay.docx", "docx");
    expect(runArgs[0]?.title).toBe(expected);
  });

  it("reveals the output path when the outcome arrives in export.rs's own wire spelling (DECISIONS #review-4-r0 S5)", async () => {
    // `ExportOutcome`'s `#[serde(rename_all = "camelCase")]` (export.rs): a literal JSON string,
    // not a TS object literal, so a wire-spelling regression fails here too, not only in export.rs's
    // own cargo test (`export_outcome_serializes_with_camel_case_keys`).
    const wire = JSON.parse('{"outPath":"essay.docx","warning":null}') as ExportOutcome;
    const { io, calls } = fakeIO("clean", wire);
    await exportDocument(io, "essay.md", "essay.docx", "docx");
    expect(calls).toContain("reveal:essay.docx");
  });
});
