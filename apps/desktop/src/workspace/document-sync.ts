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
 *   settled change reloads silently when clean, and is a conflict when dirty.
 * - A conflict shows the 'Changed on disk' banner and suspends saving until the user picks
 *   {@link DocumentSync.keepMine} (write the editor's text over the disk) or
 *   {@link DocumentSync.reload} (take the disk's text, dropping the edit).
 *
 * **One operation at a time** (DECISIONS #review-2-r0 U1, U6). Every save, Keep mine, watcher
 * check and post-rename read runs on one chain: the closure holds the in-flight promise, and each
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
   * in the same synchronous step as `serialize`: read the sidecar before the first `await`.
   */
  write(text: string): Promise<void>;
}

export interface SyncTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  now(): number;
}

export interface SyncCallbacks {
  /** The canonical Markdown of the editor's document, read at save time. */
  serialize(): string;
  /** A clean document's file changed on disk: replace the editor's document with `text`. */
  reloaded(text: string): void;
  /** The file changed on disk while the editor was dirty: show the banner. */
  conflicted(): void;
  /** `known` moved (a read, a reload, a write). */
  knownChanged(text: string): void;
  /** A read or write failed; the edit stays dirty. */
  failed(error: unknown): void;
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
   * mean it does not, and the edit is still dirty.
   */
  flush(): Promise<FlushResult>;
  /**
   * The document was renamed (the I/O now reads the new path), and the rename may have rewritten
   * its image URLs: re-read it. The same bytes as `known` change nothing; different bytes become
   * `known` and, when clean, reload like an external change. Never a conflict: the rename was ours.
   */
  renamed(): Promise<void>;
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
  const write = async (): Promise<FlushResult> => {
    const at = generation;
    const text = callbacks.serialize();
    const previous = known;
    // Known before the write lands, so the watcher's echo of this write already reads as ours.
    setKnown(text);
    try {
      await io.write(text);
    } catch (error) {
      setKnown(previous);
      callbacks.failed(error);
      return "failed";
    }
    if (generation === at) dirty = false;
    return "saved";
  };

  const save = (): Promise<FlushResult> =>
    serialised(async () => {
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
    });

  const check = (): void => {
    changeTimer = null;
    void serialised(async () => {
      // A later report scheduled its own check while this one waited behind a write.
      if (disposed || changeTimer !== null) return "clean";
      let disk: string;
      try {
        disk = await io.read();
      } catch (error) {
        // A file that is gone mid-rewrite reads as a failure; the rewrite's own report re-checks.
        callbacks.failed(error);
        return "failed";
      }
      if (disposed) return "clean";
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
      return serialised(() => (disposed ? Promise.resolve<FlushResult>("clean") : write()));
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
      if (disposed) return dirty ? "failed" : "clean";
      if (conflict) return "conflict";
      if (!dirty) return wasDirty ? "saved" : "clean";
      clearSave();
      return save();
    },
    renamed() {
      return serialised(async () => {
        if (disposed) return "clean";
        let disk: string;
        try {
          disk = await io.read();
        } catch (error) {
          callbacks.failed(error);
          return "failed";
        }
        if (disposed || disk === known) return "clean";
        setKnown(disk);
        // Dirty only if an edit landed between the flush before the rename and here; the edit
        // wins over the rewritten file, as it would have after the rename's own write.
        if (!dirty && !conflict) callbacks.reloaded(disk);
        return "clean";
      }).then(() => undefined);
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
