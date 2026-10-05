import { useState } from "react";

interface Props {
  /** The committed value, from the store. */
  readonly value: string;
  /** Commit a changed value: one store mutation, so one undo step per committed edit (§6.5). */
  readonly onCommit: (value: string) => void;
  readonly placeholder: string;
  readonly label: string;
  readonly testId: string;
  readonly index?: number;
  readonly readOnly?: boolean;
}

/**
 * A one-line field over a store value (task 3.2's question and topic fields). Typing edits a local
 * draft; Enter or leaving the field commits it, trimmed, when it differs from the value — so a
 * question typed letter by letter is one undo step, not one per letter. A new value from the store
 * (an undo, a drag that re-indexed the rows) replaces the draft.
 */
export default function QuestionField({ value, onCommit, placeholder, label, testId, index, readOnly }: Props) {
  // The draft and the store value it was started from; a new store value resets the draft during
  // render (React's "adjusting state when a prop changes"), never in an effect.
  const [field, setField] = useState({ base: value, draft: value });
  if (field.base !== value) setField({ base: value, draft: value });
  const draft = field.base === value ? field.draft : value;
  const setDraft = (next: string): void => setField({ base: value, draft: next });
  const commit = (): void => {
    const next = draft.trim();
    if (next !== value) onCommit(next);
    else if (draft !== value) setDraft(value);
  };
  return (
    <input
      type="text"
      className="question-field"
      data-testid={testId}
      data-index={index}
      aria-label={label}
      placeholder={placeholder}
      value={draft}
      readOnly={readOnly}
      onChange={(event) => setDraft(event.currentTarget.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          commit();
        }
      }}
    />
  );
}
