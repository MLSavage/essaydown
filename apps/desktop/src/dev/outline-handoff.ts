/**
 * The one-shot channel `/dev/outline`'s "Produce" button uses to hand a document to `/dev/editor`
 * (task 1.8). The two dev routes are separate page loads — `main.tsx` reads `location.pathname`
 * once and has no client router — so passing the produced Markdown by React state is not an
 * option; `sessionStorage` survives exactly the one navigation this needs and nothing longer,
 * which is what the task's "no persistence" means here.
 *
 * `read` never removes the entry: React 18 StrictMode calls a `useMemo` initializer twice on
 * mount, and a destructive read would lose the handoff on the discarded first call (the same
 * reason `DevEditor`'s `carried` cursor ref, task 1.7, is never cleared). The caller clears the
 * entry itself from a `useEffect`, which — unlike the initializer — commits only once per mount.
 */

const KEY = "essaydown:dev-outline-handoff";

export interface OutlineHandoff {
  /** Canonical Markdown built from the topic question and the outline's headings. */
  readonly markdown: string;
  /** Each heading's own question text, in document order — `/dev/editor`'s muted hint lines. */
  readonly hints: readonly string[];
}

export function writeOutlineHandoff(handoff: OutlineHandoff): void {
  sessionStorage.setItem(KEY, JSON.stringify(handoff));
}

/** Pure read: the entry is left in place so a StrictMode double-render cannot lose it. */
export function readOutlineHandoff(): OutlineHandoff | null {
  const raw = sessionStorage.getItem(KEY);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as OutlineHandoff;
    return typeof parsed.markdown === "string" && Array.isArray(parsed.hints) ? parsed : null;
  } catch {
    return null;
  }
}

export function clearOutlineHandoff(): void {
  sessionStorage.removeItem(KEY);
}
