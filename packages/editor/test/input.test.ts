import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { baseKeymap } from "prosemirror-commands";
import { EditorState, TextSelection } from "prosemirror-state";
import editorPackage from "../package.json" with { type: "json" };
import {
  editorPlugins,
  essaydownKeymap,
  exitEmptyListItem,
  markdownInputRules,
  tableFromRow,
  tableRowCells,
} from "../src/input.js";
import { schema } from "../src/schema.js";
import { Typing, type Scenario } from "./typing.js";

const SCENARIOS: { scenarios: Scenario[] } = JSON.parse(
  readFileSync(new URL("../../../fixtures/editor/input-scenarios.json", import.meta.url), "utf8"),
) as { scenarios: Scenario[] };

/**
 * The acceptance's 22 scenarios, replayed headlessly. The Playwright run in
 * `e2e/web/editor-input.spec.ts` types the same table into a real browser; this one exists because
 * the plugin logic has to be covered by the suite that measures coverage, and because a failure
 * here names the command rather than the pixel.
 */
describe("the acceptance scenarios", () => {
  it("is the 22 scenarios the acceptance asks for", () => {
    expect(SCENARIOS.scenarios).toHaveLength(22);
  });

  for (const scenario of SCENARIOS.scenarios) {
    it(scenario.name, () => {
      expect(new Typing().run(scenario.keys).markdown()).toBe(scenario.markdown);
    });
  }
});

describe("a blank document", () => {
  it("serialises to the empty string", () => {
    expect(new Typing().markdown()).toBe("");
  });

  it("is one empty paragraph, so the cursor has somewhere to be", () => {
    const { doc } = new Typing().state;
    expect(doc.childCount).toBe(1);
    expect(doc.firstChild?.type).toBe(schema.nodes.paragraph);
    expect(doc.firstChild?.content.size).toBe(0);
  });
});

describe("no history", () => {
  it("is not a dependency of the package", () => {
    const manifest = editorPackage as { dependencies: Record<string, string> };
    expect(Object.keys(manifest.dependencies)).not.toContain("prosemirror-history");
  });

  it("installs three plugins: the input rules and the two keymaps", () => {
    const plugins = editorPlugins();
    expect(plugins).toHaveLength(3);
    expect(plugins.filter((plugin) => plugin.spec.isInputRules === true)).toHaveLength(1);
    // A history plugin is the only ProseMirror core plugin with a `historyKey`-shaped state that
    // survives `undo`; the honest check available from outside is that no plugin here defines
    // state at all beyond the input rules' one-transaction memory.
    const withState = plugins.filter((plugin) => plugin.spec.state !== undefined);
    expect(withState).toHaveLength(1);
    expect(withState[0].spec.isInputRules).toBe(true);
  });

  it("binds neither Mod-z nor Mod-y", () => {
    const bound = { ...baseKeymap, ...essaydownKeymap() };
    expect(Object.keys(bound)).not.toContain("Mod-z");
    expect(Object.keys(bound)).not.toContain("Mod-y");
  });
});

describe("the rule ordering", () => {
  it("puts the code-block rule before the inline-code rule", () => {
    // Both are triggered by a backtick; if the order flipped, ``` would try to close an empty
    // inline-code span. The presence case is the code block, the absence case is that the third
    // backtick produced no inline code.
    const typed = new Typing().type("```").state;
    expect(typed.doc.firstChild?.type).toBe(schema.nodes.code_block);
    expect(typed.doc.textContent).toBe("");
  });

  it("puts the strong rule before the emphasis rule", () => {
    expect(new Typing().type("**a**").markdown()).toBe("**a**\n");
    expect(new Typing().type("*a*").markdown()).toBe("*a*\n");
  });

  it("keeps a delimiter that appears inside the content", () => {
    expect(new Typing().type("`a*b`").markdown()).toBe("`a*b`\n");
    expect(new Typing().type("**a-b**").markdown()).toBe("**a-b**\n");
  });

  it("leaves an unclosed delimiter as text", () => {
    expect(new Typing().type("*a").markdown()).toBe("\\*a\n");
  });
});

describe("the list join predicates", () => {
  it("joins an ordered item that continues the numbering", () => {
    const typed = new Typing().type("1. one").press("Enter").press("Backspace").type("2. two");
    expect(typed.state.doc.childCount).toBe(1);
    expect(typed.markdown()).toBe("1. one\n2. two\n");
  });

  it("does not join an ordered item that breaks the numbering", () => {
    const typed = new Typing().type("1. one").press("Enter").press("Backspace").type("7. seven");
    expect(typed.state.doc.childCount).toBe(2);
    // Two adjacent lists, so the formatter has to give the second a different marker or the two
    // would parse back as one list; `7)` is that, not a rule firing wrongly.
    expect(typed.markdown()).toBe("1. one\n\n7) seven\n");
  });

  it("does not join a bullet list to the ordered list above it", () => {
    const typed = new Typing().type("1. one").press("Enter").press("Backspace").type("- bullet");
    expect(typed.state.doc.childCount).toBe(2);
    expect(typed.markdown()).toBe("1. one\n\n- bullet\n");
  });

  it("joins a bullet list to the bullet list above it", () => {
    const typed = new Typing().type("- one").press("Enter").press("Backspace").type("- two");
    expect(typed.state.doc.childCount).toBe(1);
    expect(typed.markdown()).toBe("- one\n- two\n");
  });
});

describe("the thematic-break rule", () => {
  it("keeps whatever followed the cursor in the paragraph after the break", () => {
    // The only way to reach the tail branch: the rule needs `---` before the cursor, so the text
    // after it has to be there already.
    const typed = new Typing().type("--after").moveTo(3).type("-");
    expect(typed.markdown()).toBe("---\n\nafter\n");
  });

  it("leaves the cursor in that paragraph", () => {
    const typed = new Typing().type("---").type("x");
    expect(typed.markdown()).toBe("---\n\nx\n");
  });

  it("does not fire in a heading", () => {
    expect(new Typing().type("# ").type("---").markdown()).toBe("# ---\n");
  });
});

describe("tableRowCells", () => {
  it("reads the cells of a row and trims them", () => {
    expect(tableRowCells("| a | b |")).toEqual(["a", "b"]);
    expect(tableRowCells("|a|b|c|")).toEqual(["a", "b", "c"]);
    expect(tableRowCells("|only|")).toEqual(["only"]);
    expect(tableRowCells("|a||")).toEqual(["a", ""]);
  });

  it("refuses anything that is not a row, one refusal per clause", () => {
    expect(tableRowCells("|")).toBeNull();
    expect(tableRowCells("")).toBeNull();
    expect(tableRowCells("a|b|")).toBeNull();
    expect(tableRowCells("|a|b")).toBeNull();
  });
});

describe("tableFromRow", () => {
  const stateAfter = (typed: Typing): EditorState => typed.state;

  it("reports that it applies without dispatching", () => {
    const before = stateAfter(new Typing().type("|a|b|"));
    expect(tableFromRow(before, undefined)).toBe(true);
    expect(before.doc.firstChild?.type).toBe(schema.nodes.paragraph);
  });

  it("builds as many columns as the row has cells", () => {
    expect(new Typing().type("|a|b|c|").press("Enter").markdown()).toBe(
      "| a | b | c |\n| - | - | - |\n|   |   |   |\n",
    );
  });

  it("keeps an empty header cell empty", () => {
    expect(new Typing().type("|a||").press("Enter").markdown()).toBe(
      "| a |   |\n| - | - |\n|   |   |\n",
    );
  });

  it("refuses a selection that is not a cursor", () => {
    const typed = new Typing().type("|a|b|");
    const { doc } = typed.state;
    const spread = typed.state.tr.setSelection(TextSelection.create(doc, 1, 3));
    expect(tableFromRow(typed.state.apply(spread), undefined)).toBe(false);
  });

  it("refuses a block that is not a paragraph", () => {
    const typed = new Typing().type("# ").type("|a|b|");
    expect(tableFromRow(typed.state, undefined)).toBe(false);
    expect(typed.press("Enter").markdown()).toBe("# |a|b|\n");
  });

  it("refuses a paragraph that is not a row", () => {
    const typed = new Typing().type("not a row");
    expect(tableFromRow(typed.state, undefined)).toBe(false);
    expect(typed.press("Enter").type("next").markdown()).toBe("not a row\n\nnext\n");
  });
});

describe("exitEmptyListItem", () => {
  it("refuses a selection that is not a cursor", () => {
    const typed = new Typing().type("- one");
    const spread = typed.state.tr.setSelection(TextSelection.create(typed.state.doc, 3, 5));
    expect(exitEmptyListItem(typed.state.apply(spread), undefined)).toBe(false);
  });

  it("refuses a list item that still has text", () => {
    const typed = new Typing().type("- one");
    expect(exitEmptyListItem(typed.state, undefined)).toBe(false);
    // Nothing else claims the key: `baseKeymap`'s Backspace only handles block boundaries and
    // leaves deleting a character to the DOM, which a headless run does not have.
    expect(typed.press("Backspace").markdown()).toBe("- one\n");
  });

  it("refuses an empty paragraph that is not in a list", () => {
    const typed = new Typing().type("plain").press("Enter");
    expect(exitEmptyListItem(typed.state, undefined)).toBe(false);
  });

  it("refuses an empty second paragraph of a list item", () => {
    // Enter inside a non-empty item splits the item; a second block in the *same* item is what
    // `childCount !== 1` is about, so it is built here rather than typed.
    const paragraph = schema.nodes.paragraph;
    const item = schema.nodes.list_item.create(null, [
      paragraph.create(null, schema.text("one")),
      paragraph.create(),
    ]);
    const doc = schema.nodes.doc.create(null, schema.nodes.list.create(null, item));
    const state = EditorState.create({ doc, plugins: editorPlugins() });
    const cursor = state.tr.setSelection(TextSelection.create(doc, doc.content.size - 3));
    expect(exitEmptyListItem(state.apply(cursor), undefined)).toBe(false);
  });

  it("lifts the last item out when it is the empty one", () => {
    const typed = new Typing().type("- one").press("Enter").type("two").press("Enter");
    expect(exitEmptyListItem(typed.state, undefined)).toBe(true);
    expect(typed.press("Backspace").markdown()).toBe("- one\n- two\n");
  });

  it("lifts an empty item out of the middle of a list, splitting it", () => {
    const item = (text: string) =>
      schema.nodes.list_item.create(
        null,
        schema.nodes.paragraph.create(null, text === "" ? null : schema.text(text)),
      );
    const list = schema.nodes.list.create(null, [item("one"), item(""), item("three")]);
    const doc = schema.nodes.doc.create(null, list);
    const state = EditorState.create({ doc, plugins: editorPlugins() });
    // Inside the empty second item: past the list's open token, the first item, and the second
    // item's own open token and paragraph open token.
    const inEmptyItem = 1 + list.firstChild!.nodeSize + 2;
    const placed = state.apply(state.tr.setSelection(TextSelection.create(doc, inEmptyItem)));
    expect(placed.selection.$from.parent.content.size).toBe(0);

    let next = placed;
    expect(exitEmptyListItem(placed, (tr) => (next = placed.apply(tr)))).toBe(true);
    // The item leaves the list where it stood, so one list becomes list, paragraph, list.
    expect(next.doc.childCount).toBe(3);
    expect(next.doc.child(0).type).toBe(schema.nodes.list);
    expect(next.doc.child(1).type).toBe(schema.nodes.paragraph);
    expect(next.doc.child(2).type).toBe(schema.nodes.list);
  });
});

describe("the keymap", () => {
  it("leaves Tab alone outside a list, so the key can still move focus", () => {
    const tab = essaydownKeymap().Tab;
    expect(tab(new Typing().type("plain").state, undefined)).toBe(false);
  });

  it("leaves Shift-Tab alone outside a list", () => {
    const shiftTab = essaydownKeymap()["Shift-Tab"];
    expect(shiftTab(new Typing().type("plain").state, undefined)).toBe(false);
  });

  it("does nothing for a key nothing binds", () => {
    const typed = new Typing().type("plain");
    expect(typed.press("Escape").markdown()).toBe("plain\n");
  });

  it("is exactly the four keys the task names", () => {
    expect(Object.keys(essaydownKeymap()).sort()).toEqual([
      "Backspace",
      "Enter",
      "Shift-Tab",
      "Tab",
    ]);
  });
});

describe("markdownInputRules", () => {
  it("is the nine rules of the task text", () => {
    expect(markdownInputRules()).toHaveLength(9);
  });

  it("does not fire inside a code block", () => {
    // The plugin skips every rule whose `inCode` is false, and none of these sets it.
    expect(markdownInputRules().every((rule) => rule.inCode === false)).toBe(true);
  });
});
