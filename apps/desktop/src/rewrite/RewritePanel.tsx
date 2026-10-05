import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import type { Root } from "mdast";
import type { Node as PMNode } from "prosemirror-model";
import {
  applyAddVariant,
  applyDeleteOrphan,
  applyReattach,
  applyUseVariant,
  rewriteCards,
  unattachedRewrites,
  type RewriteCard,
  type UnattachedRewrite,
} from "@essaydown/core";
import { cursorBlock, mdastToPM, type DocumentStore, type ModeMutation } from "@essaydown/editor";
import { useDocumentState } from "../outline/outline-view";
import { useStoreUndoKeys } from "../modes/undo-keys";

interface Props {
  readonly store: DocumentStore;
  /** Cmd (macOS) or Ctrl (elsewhere), as the mode chords and the editor's `Mod-` read it. */
  readonly mac: boolean;
}

/** What the sidebar lists: the top-level blocks it shows cards for, and where the caret is. */
interface Focus {
  /** Root indices of the blocks shown, in order. */
  readonly blocks: readonly number[];
  /** The caret's root index and plain-text offset, or null before the editor reported a caret. */
  readonly caret: { readonly at: number; readonly offset: number | null } | null;
}

function isHeading(root: Root, at: number): boolean {
  return root.children[at]?.type === "heading";
}

/** The cursor's block, or every block between the headings around it when `section` is on. */
function focusOf(root: Root, doc: PMNode, cursor: number | null, section: boolean): Focus {
  if (cursor === null) return { blocks: [], caret: null };
  const shift = root.children[0]?.type === "yaml" ? 1 : 0;
  const position = cursorBlock(doc, cursor);
  if (position === null) return { blocks: [], caret: null };
  const at = position.block + shift;
  const caret = { at, offset: position.offset };
  if (!section) return { blocks: [at], caret };
  let first = at;
  while (first > shift && !isHeading(root, first)) first -= 1;
  if (isHeading(root, first)) first += 1;
  let last = at;
  while (last + 1 < root.children.length && !isHeading(root, last + 1)) last += 1;
  const blocks: number[] = [];
  for (let index = first; index <= last; index += 1) blocks.push(index);
  return { blocks, caret };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sentenceId(pos: readonly number[]): string {
  return `sentence-${pos.join("-")}`;
}

function posOfId(id: string | number): [number, number] | null {
  const match = /^sentence-(\d+)-(\d+)$/.exec(String(id));
  return match === null ? null : [Number(match[1]), Number(match[2])];
}

function orphanOfId(id: string | number): number | null {
  const match = /^orphan-(\d+)$/.exec(String(id));
  return match === null ? null : Number(match[1]);
}

/**
 * Rewrite mode's right sidebar (PRD §6.3, task 3.4): one card per sentence of the caret's
 * paragraph (or of every paragraph between the headings around it, with "Whole section" on), each
 * with its current text, its variants with a radio and "Use this", an add-variant field
 * (Cmd/Ctrl+Enter adds and selects) and its collapsed history; and an "Unattached" section listing
 * the rewrite entries whose sentence is gone (§6.2 step 5), each draggable onto a sentence card or
 * deletable. The card under the caret is marked active and scrolled into view.
 *
 * Every change is one store mutation from `core/rewrite.ts`, so one undo step holding both the
 * Markdown and the sidecar (§6.5); Cmd/Ctrl+Z and Shift+Cmd/Ctrl+Z pressed outside the editor and
 * the text fields step the store like the editor's keymap does.
 */
export default function RewritePanel({ store, mac }: Props) {
  const document = useDocumentState(store);
  const cursor = useSyncExternalStore(store.subscribe, () => store.getState().cursor);
  const [section, setSection] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The editor's doc for this root (the cursor is a position in it), converted once per snapshot.
  const doc = useMemo(() => mdastToPM(document.root).doc, [document.root]);
  const focus = useMemo(() => focusOf(document.root, doc, cursor, section), [document.root, doc, cursor, section]);
  const groups = useMemo(
    () => focus.blocks.map((at) => ({ at, cards: rewriteCards(document, at) })),
    [document, focus],
  );
  const orphans = useMemo(() => unattachedRewrites(document), [document]);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor),
  );

  const run = (mutation: ModeMutation): boolean => {
    try {
      store.getState().dispatch(mutation);
      setError(null);
      return true;
    } catch (failure) {
      setError(describe(failure));
      return false;
    }
  };

  const onDragEnd = (event: DragEndEvent): void => {
    const orphan = orphanOfId(event.active.id);
    const pos = event.over === null ? null : posOfId(event.over.id);
    if (orphan === null || pos === null) return;
    run((state) => applyReattach(state, orphan, pos));
  };

  useStoreUndoKeys(store, mac);

  const activeSentence = (at: number, cards: readonly RewriteCard[]): number | null => {
    if (focus.caret === null || focus.caret.at !== at || focus.caret.offset === null) return null;
    const offset = focus.caret.offset;
    let active = 0;
    cards.forEach((card, index) => {
      if (card.start <= offset) active = index;
    });
    return active;
  };

  return (
    <aside className="rewrite-panel" data-testid="rewrite-panel" aria-label="Rewrite">
      <div className="rewrite-header">
        <span className="rewrite-title">Rewrite</span>
        <label className="rewrite-expand">
          <input
            type="checkbox"
            data-testid="rewrite-expand"
            checked={section}
            onChange={(event) => setSection(event.target.checked)}
          />
          Whole section
        </label>
      </div>
      {error !== null && (
        <p className="rewrite-error" role="alert" data-testid="rewrite-error">
          {error}
        </p>
      )}
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <div className="rewrite-cards">
          {groups.length === 0 && (
            <p className="rewrite-empty" data-testid="rewrite-empty">
              Put the caret in a paragraph to rewrite its sentences.
            </p>
          )}
          {groups.map(({ at, cards }) =>
            cards === null ? (
              document.root.children[at]?.type === "list" || document.root.children[at]?.type === "blockquote" ? (
                <p key={at} className="rewrite-nested" data-testid="rewrite-nested">
                  nested — edit in the document
                </p>
              ) : focus.blocks.length === 1 ? (
                <p key={at} className="rewrite-empty" data-testid="rewrite-empty">
                  Put the caret in a paragraph to rewrite its sentences.
                </p>
              ) : null
            ) : (
              <ol key={at} className="rewrite-paragraph" data-testid="rewrite-paragraph" data-block={at}>
                {cards.map((card, index) => (
                  <SentenceCard
                    key={sentenceId(card.pos)}
                    card={card}
                    active={activeSentence(at, cards) === index}
                    run={run}
                  />
                ))}
              </ol>
            ),
          )}
        </div>
        <section className="rewrite-unattached" data-testid="rewrite-unattached">
          <h3 className="rewrite-unattached-title">Unattached</h3>
          {orphans.length === 0 ? (
            <p className="rewrite-empty">Nothing unattached.</p>
          ) : (
            <ul className="rewrite-orphans">
              {orphans.map((orphan) => (
                <OrphanCard key={orphan.index} orphan={orphan} run={run} />
              ))}
            </ul>
          )}
        </section>
      </DndContext>
    </aside>
  );
}

interface CardProps {
  readonly card: RewriteCard;
  readonly active: boolean;
  readonly run: (mutation: ModeMutation) => boolean;
}

function isModEnter(event: KeyboardEvent<HTMLElement>): boolean {
  return event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey;
}

function SentenceCard({ card, active, run }: CardProps) {
  const variants = card.entry?.variants ?? [];
  const chosen = card.entry?.chosen ?? null;
  const [selected, setSelected] = useState<number | null>(chosen);
  const [draft, setDraft] = useState("");
  const item = useRef<HTMLLIElement | null>(null);
  const { setNodeRef, isOver } = useDroppable({ id: sentenceId(card.pos) });

  // The caret's sentence is kept in view (task 3.4: "sidebar auto-scrolls to the cursor's sentence").
  useEffect(() => {
    if (active) item.current?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const add = (): void => {
    const next = variants.length;
    if (run((state) => applyAddVariant(state, card.pos, draft, new Date().toISOString()))) {
      setSelected(next);
      setDraft("");
    }
  };

  return (
    <li
      ref={(node) => {
        item.current = node;
        setNodeRef(node);
      }}
      className={`rewrite-sentence${active ? " rewrite-sentence-active" : ""}${isOver ? " rewrite-sentence-over" : ""}`}
      data-testid="rewrite-sentence"
      data-block={card.pos[0]}
      data-index={card.pos[1]}
      data-active={active ? "true" : "false"}
    >
      <p className="rewrite-sentence-text" data-testid="rewrite-sentence-text">
        {card.markdown}
        {card.duplicate && (
          <span className="rewrite-duplicate" data-testid="rewrite-duplicate" title="The same sentence appears elsewhere">
            duplicate
          </span>
        )}
      </p>
      {variants.length > 0 && (
        <ol className="rewrite-variants" data-testid="rewrite-variants">
          {variants.map((variant, index) => (
            <li key={index} className="rewrite-variant" data-testid="rewrite-variant" data-chosen={chosen === index ? "true" : "false"}>
              <label>
                <input
                  type="radio"
                  name={sentenceId(card.pos)}
                  data-testid="rewrite-variant-radio"
                  checked={selected === index}
                  onChange={() => setSelected(index)}
                />
                <span data-testid="rewrite-variant-text">{variant.text}</span>
              </label>
              {chosen === index && <span className="rewrite-in-use">in use</span>}
            </li>
          ))}
        </ol>
      )}
      <textarea
        className="rewrite-add"
        data-testid="rewrite-add"
        rows={2}
        placeholder="Another way to say it… (Cmd/Ctrl+Enter adds)"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (!isModEnter(event)) return;
          event.preventDefault();
          add();
        }}
      />
      <div className="rewrite-actions">
        <button type="button" data-testid="rewrite-add-button" disabled={draft.trim() === ""} onClick={add}>
          Add
        </button>
        <button
          type="button"
          data-testid="rewrite-use"
          disabled={selected === null || selected >= variants.length}
          onClick={() => {
            if (selected !== null) run((state) => applyUseVariant(state, card.pos, selected, new Date().toISOString()));
          }}
        >
          Use this
        </button>
      </div>
      {card.entry !== null && card.entry.history.length > 0 && (
        <details className="rewrite-history" data-testid="rewrite-history">
          <summary>History ({card.entry.history.length})</summary>
          <ol>
            {card.entry.history.map((entry, index) => (
              <li key={index} data-testid="rewrite-history-entry">
                {entry.text}
              </li>
            ))}
          </ol>
        </details>
      )}
    </li>
  );
}

interface OrphanProps {
  readonly orphan: UnattachedRewrite;
  readonly run: (mutation: ModeMutation) => boolean;
}

function OrphanCard({ orphan, run }: OrphanProps) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, isDragging } = useDraggable({
    id: `orphan-${orphan.index}`,
  });
  return (
    <li
      ref={setNodeRef}
      className={`rewrite-orphan${isDragging ? " rewrite-orphan-dragging" : ""}`}
      data-testid="rewrite-orphan"
      data-index={orphan.index}
      style={{
        transform: transform === null ? undefined : `translate3d(${transform.x}px, ${transform.y}px, 0)`,
        position: isDragging ? "relative" : undefined,
        zIndex: isDragging ? 1 : undefined,
      }}
    >
      <button
        type="button"
        ref={setActivatorNodeRef}
        className="rewrite-orphan-handle"
        data-testid="rewrite-orphan-handle"
        aria-label={`Drag onto a sentence: ${orphan.entry.anchor.text}`}
        {...attributes}
        {...listeners}
      >
        ⠿
      </button>
      <span className="rewrite-orphan-text" data-testid="rewrite-orphan-text" title={orphan.entry.anchor.text}>
        {orphan.entry.anchor.text}
      </span>
      <span className="rewrite-orphan-count">
        {orphan.entry.variants.length} variant{orphan.entry.variants.length === 1 ? "" : "s"}
      </span>
      <button
        type="button"
        className="rewrite-orphan-delete"
        data-testid="rewrite-orphan-delete"
        onClick={() => run((state) => applyDeleteOrphan(state, orphan.index))}
      >
        Delete
      </button>
    </li>
  );
}
