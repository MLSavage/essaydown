/**
 * Autosave and external-change handling for the one open document (task 2.5), as a pure state
 * machine over injected I/O and timers so every rule below is a vitest case (tests/
 * document-sync.test.ts) rather than a WebdriverIO timing.
 *
 * **What it tracks.** `known` is the text this module believes is on disk: what it last read or
 * last wrote. `dirty` means the editor holds an edit not yet written. The two together decide
 * everything:
 *
 * - An edit ({@link DocumentSync.edited}) schedules a save {@link SyncOptions.saveDelayMs} after
 *   the last one (PRD task 2.5: 500 ms). The save reads the disk first; if the disk is no longer
 *   `known`, someone else wrote since, and the save becomes a conflict instead of a write.
 * - A watcher report ({@link DocumentSync.changed}) is debounced by {@link SyncOptions.quietMs},
 *   then the file is read. The same text as `known` is this module's own write echoing back (or a
 *   touch), and is ignored. Shorter text is held for up to {@link SyncOptions.shrinkHoldMs} from
 *   the first shrink, because sync tools write by truncating and then rewriting; a report inside
 *   the hold re-reads, so truncate-then-rewrite settles on the rewritten text as one change. A
 *   settled change reloads silently when clean, and is a conflict when dirty — dirty as it stands
 *   after {@link SyncCallbacks.settle} has committed any edit the editor still holds.
 * - A conflict shows the 'Changed on disk' banner and suspends saving until the user picks
 *   {@link DocumentSync.keepMine} (write the editor's text over the disk) or
 *   {@link DocumentSync.reload} (take the disk's text, dropping the edit).
 *
 * **One operation at a time** (DECISIONS #review-2-r0 U1, U6). Every save, Keep mine, watcher
 * check and rename runs on one chain: the closure holds the in-flight promise, and each
 * operation awaits its predecessor before it touches the disk. So a {@link DocumentSync.flush}
 * during a write waits for it instead of re-reading the pre-write bytes (a spurious conflict), and
 * a watcher report during a write reads the file only after the write landed, where its own echo
 * equals `known`. `flush` reports what happened — `clean`, `saved`, `conflict` or `failed` — and a
 * caller that is about to drop this module (a switch, a rename) proceeds only on the first two.
 *
 * **One snapshot per write.** A write calls {@link SyncCallbacks.serialize} and then
 * {@link SyncIO.write} in one synchronous step, and `io.write` reads every other part of the
 * document it writes (the sidecar) before its own first `await`, so the Markdown and the sidecar
 * always come from one state of the editor.
 */

export interface SyncIO {
  /** The document's current bytes on disk. */
  read(): Promise<string>;
  /**
   * Write the editor's document (Markdown + sidecar); `text` is the Markdown being written. Called
   * in the same synchronous step as `serialize`: read the sidecar before the first `await`. A
   * failure after the Markdown landed rejects with {@link MarkdownWritten}, so the two outcomes are
   * reported apart.
   */
  write(text: string): Promise<void>;
}

/**
 * The rejection of a {@link SyncIO.write} whose Markdown reached the disk and whose later part (the
 * sidecar's read or write) failed: `cause` is that failure. The disk then holds the written text,
 * so `known` stays on it and the next save finds the disk unchanged rather than raising a false
 * 'Changed on disk' (backlog `[review-2-r2, sidecar failure after a Markdown write]`, Sol r2
 * finding 3); the edit stays dirty, so the next save writes both halves again.
 */
export class MarkdownWritten extends Error {
  constructor(readonly cause: unknown) {
    super("the Markdown was written; the sidecar was not");
    this.name = "MarkdownWritten";
  }
}

export interface SyncTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  now(): number;
}

export interface SyncCallbacks {
  /** The canonical Markdown of the editor's document, read at save time. */
  serialize(): string;
  /**
   * Replace the editor's document with `text`: a clean document's file changed on disk, or a
   * rename rewrote its asset URLs (then the document is dirty until the rewrite is written).
   */
  reloaded(text: string): void;
  /** The file changed on disk while the editor was dirty: show the banner. */
  conflicted(): void;
  /** `known` moved (a read, a reload, a write). */
  knownChanged(text: string): void;
  /** A read or write failed; the edit stays dirty. */
  failed(error: unknown): void;
  /**
   * Commit an edit the editor holds but has not reported yet (a source burst inside its coalescing
   * window), so that it reports it through {@link DocumentSync.edited} before this returns. The
   * watcher's check runs it before its clean/dirty decision and again after its awaited read, and
   * Keep mine runs it before it serialises (DECISIONS #review-3-r0 S1): a reader that decides
   * clean or dirty settles first (CLAUDE.md). A barrier runs it again after every await that typing
   * can outlast (task 4.8): `flush` after the write in flight, the drain before each recheck of
   * `dirty`, and a rename after its move and re-read. Absent: the editor reports every edit at once.
   */
  settle?(): void;
}

export interface SyncOptions {
  readonly saveDelayMs: number;
  readonly quietMs: number;
  readonly shrinkHoldMs: number;
}

export const DEFAULT_SYNC_OPTIONS: SyncOptions = {
  saveDelayMs: 500,
  // Short enough that an external append is on screen well inside a second (the acceptance), long
  // enough to fold the several events one write raises (create, modify, rename) into one read.
  quietMs: 100,
  // "file shrinks then grows within 2 s" (task 2.5).
  shrinkHoldMs: 2000,
};

/** What {@link DocumentSync.flush} found: nothing to save, saved, held by a conflict, or failed. */
export type FlushResult = "clean" | "saved" | "conflict" | "failed";

/**
 * What {@link DocumentSync.renamed} did: `moved: false` refused before the move (the result says
 * why: `conflict` or `failed`); `moved: true` moved the file, and the result is what the post-move
 * read and write found.
 */
export interface RenameOutcome {
  readonly moved: boolean;
  readonly result: FlushResult;
}

export interface DocumentSync {
  /** The editor's document changed. */
  edited(): void;
  /** The watcher reported this document. */
  changed(): void;
  /** Resolve a conflict by writing the editor's document over the disk. */
  keepMine(): Promise<FlushResult>;
  /** Resolve a conflict by taking the disk's document. */
  reload(): Promise<void>;
  /**
   * Save now if dirty (before a rename or a switch), whatever the timer says, after any write in
   * flight. `clean` and `saved` mean the disk holds the editor's document; `conflict` and `failed`
   * mean it does not, and the edit is still dirty. An edit that lands during the write is written
   * too, before `saved` (DECISIONS #review-2-r2 W1).
   */
  flush(): Promise<FlushResult>;
  /**
   * Rename the document inside this module's chain (DECISIONS #review-2-r3, task 3.11), so no save
   * can land between the move and the rewrite. In one operation: save a pending edit at the old
   * path, the way {@link flush} does; refuse on `conflict` or `failed` (`moved: false`, nothing
   * moved); `move` the file (the I/O reads the new path from then on; a rejection is rethrown,
   * nothing moved); re-read it; and write `rewrite` of the document there. The document is the
   * disk's bytes when clean (a clean reload, not a canonicalisation) and the editor's when an edit
   * landed during the move; a rewrite that changes it reloads the editor (still holding the edit)
   * and is written at once, with any edit made during that write, so `saved` covers the latest
   * generation (DECISIONS #review-2-r2 W1). An edit with the disk changed by another writer since
   * the barrier keeps the edit, rewritten, behind a conflict, so Keep mine writes the new stem.
   */
  renamed(rewrite: (text: string) => string, move: () => Promise<void>): Promise<RenameOutcome>;
  /** Stop every timer; later reports and edits are ignored. */
  dispose(): void;
  readonly dirty: boolean;
  readonly conflict: boolean;
}

export function createDocumentSync(
  initialText: string,
  io: SyncIO,
  callbacks: SyncCallbacks,
  timers: SyncTimers,
  options: SyncOptions = DEFAULT_SYNC_OPTIONS,
): DocumentSync {
  let known = initialText;
  let dirty = false;
  let conflict = false;
  let disposed = false;
  // Bumped on every edit, so a save that finishes after a later edit leaves the document dirty.
  let generation = 0;
  let saveTimer: unknown = null;
  let changeTimer: unknown = null;
  let holdStartedAt: number | null = null;

  const setKnown = (text: string): void => {
    known = text;
    callbacks.knownChanged(text);
  };

  const clearSave = (): void => {
    if (saveTimer !== null) timers.clearTimeout(saveTimer);
    saveTimer = null;
  };

  const clearChange = (): void => {
    if (changeTimer !== null) timers.clearTimeout(changeTimer);
    changeTimer = null;
  };

  const enterConflict = (): void => {
    clearSave();
    if (conflict) return;
    conflict = true;
    callbacks.conflicted();
  };

  // The operation in flight, or null. `serialised` chains each new one behind it.
  let inFlight: Promise<FlushResult> | null = null;

  const serialised = (operation: () => Promise<FlushResult>): Promise<FlushResult> => {
    const before = inFlight;
    const next = (async () => {
      if (before !== null) await before;
      return operation();
    })();
    inFlight = next;
    void next.then(() => {
      if (inFlight === next) inFlight = null;
    });
    return next;
  };

  const settle = async (): Promise<void> => {
    while (inFlight !== null) await inFlight;
  };

  // Only ever inside a `serialised` operation.
  // `text` is the editor's document unless a rename hands its rewrite before the editor reloads.
  const write = async (text: string = callbacks.serialize()): Promise<FlushResult> => {
    const at = generation;
    const previous = known;
    // Known before the write lands, so the watcher's echo of this write already reads as ours.
    setKnown(text);
    try {
      await io.write(text);
    } catch (error) {
      if (error instanceof MarkdownWritten) {
        callbacks.failed(error.cause);
        return "failed";
      }
      setKnown(previous);
      callbacks.failed(error);
      return "failed";
    }
    if (generation === at) dirty = false;
    return "saved";
  };

  // Only ever inside a `serialised` operation: re-read, and write unless the disk changed.
  const saveOnce = async (): Promise<FlushResult> => {
    if (disposed || conflict) return conflict ? "conflict" : "clean";
    if (!dirty) return "clean";
    let disk: string;
    try {
      disk = await io.read();
    } catch (error) {
      callbacks.failed(error);
      return "failed";
    }
    if (disposed) return "clean";
    if (conflict) return "conflict";
    if (disk !== known) {
      enterConflict();
      return "conflict";
    }
    return write();
  };

  // Only ever inside a `serialised` operation, after a barrier's write: while an edit landed
  // during the write (`saved` but still dirty), write the newer document the way a save does, so
  // `saved` means the disk holds the latest generation (DECISIONS #review-2-r2 W1). An edit still
  // pending in the editor (a source burst typed during the write) is committed before each recheck
  // (task 4.8). A dispose stops the drain, and the edit it leaves unwritten is `failed`, as `flush`
  // reports it.
  const drain = async (first: FlushResult): Promise<FlushResult> => {
    let result = first;
    while (result === "saved" && settled()) {
      if (disposed) return "failed";
      clearSave();
      result = await saveOnce();
      // Disposed during the re-read: the newer edit was not written.
      if (result === "clean" && dirty) return "failed";
    }
    return result;
  };

  const save = (): Promise<FlushResult> => serialised(saveOnce);

  // Commit any edit the editor still holds, then read `dirty`.
  const settled = (): boolean => {
    callbacks.settle?.();
    return dirty;
  };

  const check = (): void => {
    changeTimer = null;
    void serialised(async () => {
      // A later report scheduled its own check while this one waited behind a write.
      if (disposed || changeTimer !== null) return "clean";
      callbacks.settle?.();
      let disk: string;
      try {
        disk = await io.read();
      } catch (error) {
        // A file that is gone mid-rewrite reads as a failure; the rewrite's own report re-checks.
        callbacks.failed(error);
        return "failed";
      }
      if (disposed) return "clean";
      // An edit made during the read is pending again, and decides the outcome as much as one
      // made before it (DECISIONS #review-2-r2 W1's shape).
      callbacks.settle?.();
      if (disk === known) {
        holdStartedAt = null;
        return "clean";
      }
      if (disk.length < known.length) {
        const now = timers.now();
        holdStartedAt ??= now;
        const left = holdStartedAt + options.shrinkHoldMs - now;
        if (left > 0) {
          changeTimer = timers.setTimeout(check, left);
          return "clean";
        }
      }
      holdStartedAt = null;
      if (dirty || conflict) {
        enterConflict();
        return "conflict";
      }
      setKnown(disk);
      callbacks.reloaded(disk);
      return "clean";
    });
  };

  return {
    edited() {
      if (disposed) return;
      generation += 1;
      dirty = true;
      if (conflict) return;
      clearSave();
      saveTimer = timers.setTimeout(() => {
        saveTimer = null;
        void save();
      }, options.saveDelayMs);
    },
    changed() {
      if (disposed) return;
      clearChange();
      changeTimer = timers.setTimeout(check, options.quietMs);
    },
    keepMine() {
      if (disposed) return Promise.resolve<FlushResult>(dirty ? "failed" : "clean");
      conflict = false;
      clearSave();
      return serialised(async () => {
        if (disposed) return "clean";
        // The text typed inside the window is part of "mine".
        callbacks.settle?.();
        return drain(await write());
      });
    },
    async reload() {
      if (disposed) return;
      clearSave();
      let disk: string;
      try {
        disk = await io.read();
      } catch (error) {
        callbacks.failed(error);
        return;
      }
      conflict = false;
      dirty = false;
      generation += 1;
      setKnown(disk);
      callbacks.reloaded(disk);
    },
    async flush() {
      const wasDirty = dirty;
      await settle();
      // Typing during the write in flight is pending again (task 4.8).
      const pending = settled();
      if (disposed) return pending ? "failed" : "clean";
      if (conflict) return "conflict";
      if (!pending) return wasDirty ? "saved" : "clean";
      clearSave();
      return serialised(async () => drain(await saveOnce()));
    },
    async renamed(rewrite, move) {
      let moved = false;
      let moveError: { error: unknown } | null = null;
      const result = await serialised(async () => {
        if (disposed) return "failed";
        if (conflict) return "conflict";
        if (dirty) {
          clearSave();
          const flushed = await drain(await saveOnce());
          if (flushed !== "saved" && flushed !== "clean") return flushed;
        }
        if (disposed) return "failed";
        try {
          await move();
        } catch (error) {
          moveError = { error };
          return "failed";
        }
        moved = true;
        let disk: string;
        try {
          disk = await io.read();
        } catch (error) {
          callbacks.failed(error);
          return "failed";
        }
        // Typing during the move or the read is part of the document written there (task 4.8).
        callbacks.settle?.();
        if (disposed) return dirty ? "failed" : "clean";
        clearSave();
        if (dirty && disk !== known) {
          // Another writer since the barrier: the edit stays, under the new stem, behind the banner.
          setKnown(disk);
          const mine = callbacks.serialize();
          const rewritten = rewrite(mine);
          if (rewritten !== mine) callbacks.reloaded(rewritten);
          enterConflict();
          return "conflict";
        }
        const base = dirty ? callbacks.serialize() : disk;
        const next = rewrite(base);
        if (next === base) {
          if (dirty) return drain(await write());
          if (disk !== known) {
            setKnown(disk);
            callbacks.reloaded(disk);
          }
          return "clean";
        }
        // The rewrite is a change the disk does not hold yet: dirty until written.
        generation += 1;
        dirty = true;
        callbacks.reloaded(next);
        return drain(await write(next));
      });
      if (moveError !== null) throw (moveError as { error: unknown }).error;
      return { moved, result };
    },
    dispose() {
      disposed = true;
      clearSave();
      clearChange();
    },
    get dirty() {
      return dirty;
    },
    get conflict() {
      return conflict;
    },
  };
}
