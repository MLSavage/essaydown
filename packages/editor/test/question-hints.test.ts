import { describe, expect, it } from "vitest";
import { EditorState } from "prosemirror-state";
import type { Node as PMNode } from "prosemirror-model";
import {
  QUESTION_HINT_CLASS,
  hintDOM,
  questionHintDecorations,
  questionHintsPlugin,
} from "../src/question-hints.js";
import { schema } from "../src/schema.js";

/**
 * The headless half of task 3.3's Produce mode question hints (PRD §6.3): the browser acceptance
 * (e2e/shell/test/produce.spec.ts) asserts the rendered `.question-hint` elements against a real
 * document and sidecar; this file covers the decoration-building logic and the widget element's
 * own wiring, the same split reveal.test.ts makes for the reveal plugin.
 */

function paragraph(text: string): PMNode {
  return schema.node("paragraph", null, [schema.text(text)]);
}

function heading(depth: number, text: string): PMNode {
  return schema.node("heading", { depth }, [schema.text(text)]);
}

const DOC = schema.node("doc", null, [
  heading(2, "First"),
  paragraph("one"),
  heading(2, "Second"),
  paragraph("two"),
  heading(3, "Third"),
  paragraph("three"),
]);

function stateFor(doc: PMNode): EditorState {
  return EditorState.create({ doc });
}

/** The document position of every top-level heading in `doc`, in order — the ground truth the
 * decoration positions are checked against, derived independently of `questionHintDecorations`. */
function headingPositions(doc: PMNode): number[] {
  const positions: number[] = [];
  doc.forEach((node, offset) => {
    if (node.type === schema.nodes.heading) positions.push(offset);
  });
  return positions;
}

describe("questionHintDecorations", () => {
  it("is empty when disabled, even with questions to show", () => {
    const decorations = questionHintDecorations(stateFor(DOC), () => false, () => ["Q0", "Q1", "Q2"], () => {});
    expect(decorations.find()).toEqual([]);
  });

  it("draws one widget per heading that has a question, at that heading's own position", () => {
    const positions = headingPositions(DOC);
    const decorations = questionHintDecorations(stateFor(DOC), () => true, () => ["Q0", "Q1", "Q2"], () => {});
    const found = decorations.find();
    expect(found).toHaveLength(3);
    expect(found.map((d) => [d.from, d.to])).toEqual(positions.map((p) => [p, p]));
  });

  it("the first heading with no question draws nothing; the middle and last, which have one, do", () => {
    const positions = headingPositions(DOC);
    const decorations = questionHintDecorations(stateFor(DOC), () => true, () => ["", "Q1", "Q2"], () => {});
    const found = decorations.find();
    expect(found).toHaveLength(2);
    expect(found.map((d) => d.from)).toEqual([positions[1], positions[2]]);
  });

  it("a heading past the end of questionsOf's list is treated as having no question", () => {
    const decorations = questionHintDecorations(stateFor(DOC), () => true, () => ["Q0"], () => {});
    expect(decorations.find()).toHaveLength(1);
  });

  it("keys each widget by its heading index and question, so a redraw can reuse it", () => {
    const decorations = questionHintDecorations(stateFor(DOC), () => true, () => ["Q0", "Q1", "Q2"], () => {});
    expect(decorations.find().map((d) => d.spec.key)).toEqual([
      "question-hint:0:Q0",
      "question-hint:1:Q1",
      "question-hint:2:Q2",
    ]);
  });

  it("reads enabled and questionsOf fresh on every draw, caching neither", () => {
    let calls = 0;
    const questionsOf = (): string[] => {
      calls += 1;
      return ["Q0", "Q1", "Q2"];
    };
    questionHintDecorations(stateFor(DOC), () => true, questionsOf, () => {});
    questionHintDecorations(stateFor(DOC), () => true, questionsOf, () => {});
    expect(calls).toBe(2);
  });

  it("mutates nothing: the document is the same before and after", () => {
    const before = JSON.stringify(DOC.toJSON());
    questionHintDecorations(stateFor(DOC), () => true, () => ["Q0", "Q1", "Q2"], () => {});
    expect(JSON.stringify(DOC.toJSON())).toBe(before);
  });
});

describe("questionHintsPlugin", () => {
  it("has no state of its own: its decorations prop is a pure function of the state it is given", () => {
    const plugin = questionHintsPlugin(
      () => true,
      () => ["Q0", "Q1", "Q2"],
      () => {},
    );
    const fromProp = plugin.props.decorations?.call(plugin, stateFor(DOC));
    expect((fromProp as ReturnType<typeof questionHintDecorations>).find()).toHaveLength(3);
    expect(plugin.spec.state).toBeUndefined();
  });

  it("an activated widget calls the plugin's own onActivate, not a shared global", () => {
    let activated = 0;
    const plugin = questionHintsPlugin(
      () => true,
      () => ["Q0"],
      () => {
        activated += 1;
      },
    );
    const listeners: Record<string, (() => void)[]> = {};
    const ownerDocument = {
      createElement: () => ({
        setAttribute: () => {},
        addEventListener: (type: string, listener: () => void) => {
          (listeners[type] ??= []).push(listener);
        },
        set className(_v: string) {},
        set textContent(_v: string | null) {},
      }),
    };
    const decorations = plugin.props.decorations?.call(plugin, stateFor(DOC)) as
      | ReturnType<typeof questionHintDecorations>
      | undefined;
    const decoration = decorations?.find()[0];
    const widget = decoration as unknown as { type: { toDOM: (view: unknown) => unknown } };
    widget.type.toDOM({ dom: { ownerDocument } });
    listeners.click?.[0]?.();
    expect(activated).toBe(1);
  });
});

describe("hintDOM", () => {
  interface FakeElement {
    tagName: string;
    className: string;
    textContent: string | null;
    attributes: Record<string, string>;
    listeners: Record<string, ((event: { preventDefault(): void }) => void)[]>;
    setAttribute(name: string, value: string): void;
    addEventListener(type: string, listener: (event: { preventDefault(): void }) => void): void;
  }

  function fakeView(): { view: { dom: { ownerDocument: Document } }; created: FakeElement[] } {
    const created: FakeElement[] = [];
    const ownerDocument = {
      createElement(tagName: string): FakeElement {
        const element: FakeElement = {
          tagName,
          className: "",
          textContent: null,
          attributes: {},
          listeners: {},
          setAttribute(name, value) {
            element.attributes[name] = value;
          },
          addEventListener(type, listener) {
            (element.listeners[type] ??= []).push(listener);
          },
        };
        created.push(element);
        return element;
      },
    };
    return { view: { dom: { ownerDocument: ownerDocument as unknown as Document } }, created };
  }

  it("is a non-editable, labelled div holding the literal question", () => {
    const { view, created } = fakeView();
    const element = hintDOM("Why this?", () => {})(view) as unknown as FakeElement;
    expect(created).toHaveLength(1);
    expect(element.tagName).toBe("div");
    expect(element.className).toBe(QUESTION_HINT_CLASS);
    expect(element.textContent).toBe("Why this?");
    expect(element.attributes.contenteditable).toBe("false");
    expect(element.attributes["data-testid"]).toBe("question-hint");
  });

  it("builds one element per call, from the view's own document", () => {
    const { view, created } = fakeView();
    const make = hintDOM("Why this?", () => {});
    make(view);
    make(view);
    expect(created).toHaveLength(2);
  });

  it("calls onActivate on click, and prevents the mousedown default so no selection drag starts", () => {
    const { view, created } = fakeView();
    let activated = 0;
    hintDOM("Why this?", () => {
      activated += 1;
    })(view);
    const element = created[0];
    let prevented = false;
    element.listeners.mousedown?.[0]?.({ preventDefault: () => (prevented = true) });
    expect(prevented).toBe(true);
    expect(activated).toBe(0);
    element.listeners.click?.[0]?.({ preventDefault: () => {} });
    expect(activated).toBe(1);
  });
});
