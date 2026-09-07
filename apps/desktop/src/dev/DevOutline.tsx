import { useCallback, useState, type CSSProperties } from "react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { buildOutlineDocument, type OutlineQuestion } from "./outline-document.js";
import { writeOutlineHandoff } from "./outline-handoff.js";
import "./dev-outline.css";

/**
 * The `/dev/outline` route of PRD §8 (Phase 1): a throwaway prototype of PRD §3 step 2 — type the
 * topic question, add supporting questions, nest one under another, drag them into order, then
 * "Produce" opens `/dev/editor` (task 1.7's route) on the document those questions describe. No
 * persistence: nothing here survives a reload except by way of a single Produce (`outline-handoff.ts`).
 *
 * Nesting is one level (H2 for a top-level question, H3 for a question nested under one), which
 * is all the task text names; `OutlineQuestion.depth` and its ordering rule are documented in
 * `outline-document.ts`, which this route shares with nothing else.
 *
 * Dev-only, and pure web: nothing here calls Tauri, so Playwright can drive it (PRD §4).
 */
export default function DevOutline() {
  const [topic, setTopic] = useState("");
  const [draft, setDraft] = useState("");
  const [questions, setQuestions] = useState<OutlineQuestion[]>([]);
  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const addQuestion = useCallback(() => {
    const text = draft.trim();
    if (text === "") return;
    setQuestions((current) => [...current, { id: crypto.randomUUID(), text, depth: 0 }]);
    setDraft("");
  }, [draft]);

  const removeQuestion = useCallback((id: string) => {
    setQuestions((current) => current.filter((question) => question.id !== id));
  }, []);

  const nestQuestion = useCallback((id: string) => {
    setQuestions((current) => {
      const index = current.findIndex((question) => question.id === id);
      if (index <= 0 || current[index].depth !== 0) return current;
      if (!current.slice(0, index).some((question) => question.depth === 0)) return current;
      const next = [...current];
      next[index] = { ...next[index], depth: 1 };
      return next;
    });
  }, []);

  const outdentQuestion = useCallback((id: string) => {
    setQuestions((current) =>
      current.map((question) => (question.id === id ? { ...question, depth: 0 } : question)),
    );
  }, []);

  // Drag reorders siblings only — the two depths the task text names have their own boundary
  // (nest/outdent), so a drop across depths is a no-op rather than a silent re-nesting.
  const onDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    if (over === null || active.id === over.id) return;
    setQuestions((current) => {
      const activeIndex = current.findIndex((question) => question.id === active.id);
      const overIndex = current.findIndex((question) => question.id === over.id);
      if (activeIndex === -1 || overIndex === -1) return current;
      if (current[activeIndex].depth !== current[overIndex].depth) return current;
      return arrayMove(current, activeIndex, overIndex);
    });
  }, []);

  const canProduce = topic.trim() !== "" && questions.length > 0;
  const produce = useCallback(() => {
    if (!canProduce) return;
    writeOutlineHandoff(buildOutlineDocument(topic.trim(), questions));
    window.location.assign("/dev/editor");
  }, [canProduce, topic, questions]);

  return (
    <main className="dev-outline">
      <h1 className="dev-outline-title">/dev/outline</h1>
      <label className="dev-outline-topic">
        Topic question
        <input
          data-testid="topic"
          value={topic}
          onChange={(event) => setTopic(event.currentTarget.value)}
        />
      </label>
      <form
        className="dev-outline-add"
        onSubmit={(event) => {
          event.preventDefault();
          addQuestion();
        }}
      >
        <input
          data-testid="question-draft"
          value={draft}
          onChange={(event) => setDraft(event.currentTarget.value)}
          placeholder="Add a question…"
        />
        <button type="submit" data-testid="add-question">
          Add
        </button>
      </form>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext
          items={questions.map((question) => question.id)}
          strategy={verticalListSortingStrategy}
        >
          <ul className="dev-outline-list">
            {questions.map((question, index) => (
              <OutlineRow
                key={question.id}
                question={question}
                canNest={index > 0 && questions.slice(0, index).some((q) => q.depth === 0)}
                onNest={() => nestQuestion(question.id)}
                onOutdent={() => outdentQuestion(question.id)}
                onRemove={() => removeQuestion(question.id)}
              />
            ))}
          </ul>
        </SortableContext>
      </DndContext>
      <button type="button" data-testid="produce" disabled={!canProduce} onClick={produce}>
        Produce
      </button>
    </main>
  );
}

interface OutlineRowProps {
  readonly question: OutlineQuestion;
  readonly canNest: boolean;
  readonly onNest: () => void;
  readonly onOutdent: () => void;
  readonly onRemove: () => void;
}

function OutlineRow({ question, canNest, onNest, onOutdent, onRemove }: OutlineRowProps) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({
    id: question.id,
  });
  const style: CSSProperties = {
    transform:
      transform !== null ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
    transition: transition ?? undefined,
  };

  return (
    <li
      ref={setNodeRef}
      style={style}
      className="dev-outline-question"
      data-testid="outline-question"
      data-depth={question.depth}
    >
      <button
        type="button"
        className="dev-outline-handle"
        aria-label={`Drag ${question.text}`}
        {...attributes}
        {...listeners}
      >
        ⠿
      </button>
      <span className="dev-outline-question-text">{question.text}</span>
      {question.depth === 0 ? (
        <button type="button" data-testid="nest" disabled={!canNest} onClick={onNest}>
          Nest
        </button>
      ) : (
        <button type="button" data-testid="outdent" onClick={onOutdent}>
          Outdent
        </button>
      )}
      <button
        type="button"
        data-testid="remove"
        aria-label={`Remove ${question.text}`}
        onClick={onRemove}
      >
        ×
      </button>
    </li>
  );
}
