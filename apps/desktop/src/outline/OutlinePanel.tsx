import { useMemo, useState } from "react";
import {
  applyNewQuestion,
  applySetQuestion,
  applySetTopicQuestion,
  outlineOf,
  topicQuestionEditable,
} from "@essaydown/core";
import type { DocumentStore } from "@essaydown/editor";
import QuestionField from "./QuestionField";
import { useDocumentState } from "./outline-view";

interface Props {
  readonly store: DocumentStore;
}

/**
 * Outline mode's main pane (PRD §6.3, task 3.2): the topic question field at the top, then every
 * section as a question — its question when it has one, else its heading's text — with an inline
 * field for the question, then "New question". Every edit is one of `core/outline.ts`'s mutations
 * dispatched on the document store, so each is one undo step holding both halves (§6.5), and the
 * Markdown changes only where §6.1 lets it: "New question" appends a heading, and the topic field
 * rewrites the front matter's `question:` line when the document has one.
 *
 * The questions live in the sidecar, not in the headings (DECISIONS #002-outline-feel): a heading
 * can be renamed in the editor and its question stays.
 */
export default function OutlinePanel({ store }: Props) {
  const document = useDocumentState(store);
  const items = useMemo(() => outlineOf(document), [document]);
  const editable = topicQuestionEditable(document.root);
  const [draft, setDraft] = useState("");

  const addQuestion = (): void => {
    const text = draft.trim();
    if (text === "") return;
    store.getState().dispatch((state) => applyNewQuestion(state, text));
    setDraft("");
  };

  return (
    <section className="outline-panel" data-testid="outline-panel" aria-label="Outline">
      <label className="outline-topic">
        <span className="outline-topic-label">Topic question</span>
        <QuestionField
          testId="topic-question"
          label="Topic question"
          placeholder="What is this essay asking?"
          value={document.sidecar.topicQuestion ?? ""}
          readOnly={!editable}
          onCommit={(value) => store.getState().dispatch((state) => applySetTopicQuestion(state, value))}
        />
      </label>
      {!editable && (
        <p className="outline-topic-readonly" data-testid="topic-question-readonly">
          Edit this in the source view
        </p>
      )}
      <ol className="outline-questions">
        {items.map((item) => (
          <li
            key={item.index}
            className="outline-section"
            data-testid="outline-section"
            data-index={item.index}
            data-depth={item.depth}
            style={{ paddingLeft: `${(item.depth - 1) * 16}px` }}
          >
            <span className="outline-section-title" data-testid="outline-section-title">
              {item.question === "" ? item.text : item.question}
            </span>
            <QuestionField
              testId="question-field"
              index={item.index}
              label={`Question for ${item.text}`}
              placeholder="Question…"
              value={item.question}
              onCommit={(value) => store.getState().dispatch((state) => applySetQuestion(state, item.index, value))}
            />
          </li>
        ))}
      </ol>
      <form
        className="outline-new-question"
        onSubmit={(event) => {
          event.preventDefault();
          addQuestion();
        }}
      >
        <input
          type="text"
          data-testid="new-question"
          aria-label="New question"
          placeholder="New question…"
          value={draft}
          onChange={(event) => setDraft(event.currentTarget.value)}
        />
        <button type="submit" data-testid="add-question" disabled={draft.trim() === ""}>
          New question
        </button>
      </form>
    </section>
  );
}
