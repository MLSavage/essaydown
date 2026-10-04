import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rewriteAssetUrls } from "../packages/core/src/assets.js";
import {
  createDocumentSync,
  DEFAULT_SYNC_OPTIONS,
  type DocumentSync,
} from "../apps/desktop/src/workspace/document-sync.js";

// apps/desktop/src/workspace/document-sync.ts (task 2.5): autosave debounce, the watcher's echo,
// the shrink hold and the conflict, driven through vitest's fake clock. `disk` is the file; the
// editor's document is `editor`, which `serialize` hands to the save.

interface Harness {
  sync: DocumentSync;
  disk: { text: string };
  editor: { text: string };
  writes: string[];
  reloads: string[];
  conflicts: number;
  known: string[];
  failures: unknown[];
  reads: number;
  /** Every write as it starts, before it lands. */
  started: string[];
  /** Writes from now on reject (initially the `failWrite` argument). */
  failWrite: boolean;
  /** Runs after each write lands (another writer, a dispose), before the next operation. */
  afterWrite: (() => void) | null;
}

/** A write that lands only when `release` is called (a write in flight). */
function gated(): { wait: Promise<void>; release: () => void } {
  let release: () => void = () => {};
  const wait = new Promise<void>((resolve) => (release = resolve));
  return { wait, release };
}

function harness(
  initial: string,
  options = DEFAULT_SYNC_OPTIONS,
  failWrite = false,
  gate: Promise<void> | null = null,
): Harness {
  const h: Omit<Harness, "sync"> = {
    disk: { text: initial },
    editor: { text: initial },
    writes: [],
    reloads: [],
    conflicts: 0,
    known: [],
    failures: [],
    reads: 0,
    started: [],
    failWrite,
    afterWrite: null,
  };
  const sync = createDocumentSync(
    initial,
    {
      read: async () => {
        h.reads += 1;
        return h.disk.text;
      },
      write: async (text) => {
        h.started.push(text);
        if (gate !== null) await gate;
        if (h.failWrite) throw new Error("disk full");
        h.writes.push(text);
        h.disk.text = text;
        h.afterWrite?.();
      },
    },
    {
      serialize: () => h.editor.text,
      reloaded: (text) => {
        h.reloads.push(text);
        h.editor.text = text;
      },
      conflicted: () => {
        h.conflicts += 1;
      },
      knownChanged: (text) => h.known.push(text),
      failed: (error) => h.failures.push(error),
    },
    {
      setTimeout: (callback, ms) => setTimeout(callback, ms),
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      now: () => Date.now(),
    },
    options,
  );
  return Object.assign(h, { sync });
}

function edit(h: Harness, text: string): void {
  h.editor.text = text;
  h.sync.edited();
}

const { saveDelayMs, quietMs, shrinkHoldMs } = DEFAULT_SYNC_OPTIONS;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("autosave", () => {
  it("saves the serialised document once, saveDelayMs after the last edit", async () => {
    const h = harness("a\n");
    edit(h, "ab\n");
    await vi.advanceTimersByTimeAsync(saveDelayMs - 1);
    edit(h, "abc\n");
    await vi.advanceTimersByTimeAsync(saveDelayMs - 1);
    expect(h.writes).toEqual([]);
    expect(h.sync.dirty).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.writes).toEqual(["abc\n"]);
    expect(h.sync.dirty).toBe(false);
  });

  it("writes nothing when nothing was edited", async () => {
    const h = harness("a\n");
    await vi.advanceTimersByTimeAsync(saveDelayMs * 4);
    await h.sync.flush();
    expect(h.writes).toEqual([]);
  });

  it("stays dirty when an edit lands while the save is in flight", async () => {
    const h = harness("a\n");
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const slow = createDocumentSync(
      "a\n",
      {
        read: async () => h.disk.text,
        write: async (text) => {
          await gate;
          h.disk.text = text;
        },
      },
      { serialize: () => h.editor.text, reloaded: () => {}, conflicted: () => {}, knownChanged: () => {}, failed: () => {} },
      { setTimeout, clearTimeout: (x) => clearTimeout(x as ReturnType<typeof setTimeout>), now: Date.now },
    );
    h.editor.text = "ab\n";
    slow.edited();
    await vi.advanceTimersByTimeAsync(saveDelayMs);
    h.editor.text = "abc\n";
    slow.edited();
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.disk.text).toBe("ab\n");
    expect(slow.dirty).toBe(true);
    await vi.advanceTimersByTimeAsync(saveDelayMs);
    expect(h.disk.text).toBe("abc\n");
    expect(slow.dirty).toBe(false);
  });

  it("a failed write keeps the edit dirty, restores known and reports the error", async () => {
    const h = harness("a\n", DEFAULT_SYNC_OPTIONS, true);
    edit(h, "ab\n");
    await vi.advanceTimersByTimeAsync(saveDelayMs);
    expect(h.failures).toHaveLength(1);
    expect(h.sync.dirty).toBe(true);
    expect(h.known).toEqual(["ab\n", "a\n"]);
  });

  it("flush saves at once and cancels the timer", async () => {
    const h = harness("a\n");
    edit(h, "ab\n");
    await h.sync.flush();
    expect(h.writes).toEqual(["ab\n"]);
    await vi.advanceTimersByTimeAsync(saveDelayMs * 2);
    expect(h.writes).toEqual(["ab\n"]);
  });
});

describe("external changes", () => {
  it("the watcher's echo of our own save is not a change", async () => {
    const h = harness("a\n");
    edit(h, "ab\n");
    await vi.advanceTimersByTimeAsync(saveDelayMs);
    h.sync.changed();
    await vi.advanceTimersByTimeAsync(quietMs);
    expect(h.reloads).toEqual([]);
    expect(h.conflicts).toBe(0);
  });

  it("a clean document reloads silently, quietMs after the last report", async () => {
    const h = harness("a\n");
    h.disk.text = "a\nb\n";
    h.sync.changed();
    h.sync.changed();
    await vi.advanceTimersByTimeAsync(quietMs - 1);
    expect(h.reloads).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.reloads).toEqual(["a\nb\n"]);
    expect(h.conflicts).toBe(0);
    expect(h.writes).toEqual([]);
  });

  it("a dirty document conflicts instead of reloading, and saving is suspended", async () => {
    const h = harness("a\n");
    edit(h, "ax\n");
    h.disk.text = "a\nb\n";
    h.sync.changed();
    await vi.advanceTimersByTimeAsync(quietMs);
    expect(h.conflicts).toBe(1);
    expect(h.reloads).toEqual([]);
    edit(h, "axy\n");
    await vi.advanceTimersByTimeAsync(saveDelayMs * 4);
    expect(h.writes).toEqual([]);
    expect(h.sync.conflict).toBe(true);
  });

  it("a save that finds the disk changed conflicts instead of writing", async () => {
    const h = harness("a\n");
    edit(h, "ax\n");
    h.disk.text = "a\nb\n"; // written externally, not yet reported by the watcher
    await vi.advanceTimersByTimeAsync(saveDelayMs);
    expect(h.writes).toEqual([]);
    expect(h.conflicts).toBe(1);
  });

  it("Keep mine writes the editor's document over the disk", async () => {
    const h = harness("a\n");
    edit(h, "ax\n");
    h.disk.text = "a\nb\n";
    h.sync.changed();
    await vi.advanceTimersByTimeAsync(quietMs);
    await h.sync.keepMine();
    expect(h.disk.text).toBe("ax\n");
    expect(h.sync.conflict).toBe(false);
    expect(h.sync.dirty).toBe(false);
    h.sync.changed(); // the echo
    await vi.advanceTimersByTimeAsync(quietMs);
    expect(h.reloads).toEqual([]);
  });

  it("Reload takes the disk's current document and drops the edit", async () => {
    const h = harness("a\n");
    edit(h, "ax\n");
    h.disk.text = "a\nb\n";
    h.sync.changed();
    await vi.advanceTimersByTimeAsync(quietMs);
    h.disk.text = "a\nb\nc\n";
    await h.sync.reload();
    expect(h.reloads).toEqual(["a\nb\nc\n"]);
    expect(h.sync.conflict).toBe(false);
    expect(h.sync.dirty).toBe(false);
    await vi.advanceTimersByTimeAsync(saveDelayMs * 2);
    expect(h.writes).toEqual([]);
  });

  it("truncate then rewrite inside the hold settles as one reload of the rewritten text", async () => {
    const h = harness("# T\n\nOne.\n");
    h.disk.text = "";
    h.sync.changed();
    await vi.advanceTimersByTimeAsync(quietMs + 300);
    expect(h.reloads).toEqual([]);
    h.disk.text = "# T\n\nOne.\n\nTwo.\n";
    h.sync.changed();
    await vi.advanceTimersByTimeAsync(quietMs);
    expect(h.reloads).toEqual(["# T\n\nOne.\n\nTwo.\n"]);
    await vi.advanceTimersByTimeAsync(shrinkHoldMs * 2);
    expect(h.reloads).toHaveLength(1);
  });

  it("a shrink that is not followed by a rewrite reloads once, shrinkHoldMs after it was first read", async () => {
    const h = harness("# T\n\nOne.\n\nTwo.\n");
    h.disk.text = "# T\n\nOne.\n";
    h.sync.changed();
    await vi.advanceTimersByTimeAsync(quietMs);
    await vi.advanceTimersByTimeAsync(shrinkHoldMs - 1);
    expect(h.reloads).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.reloads).toEqual(["# T\n\nOne.\n"]);
  });

  it("a report inside the hold does not restart the hold", async () => {
    const h = harness("abcdef\n");
    h.disk.text = "abc\n";
    h.sync.changed();
    await vi.advanceTimersByTimeAsync(quietMs + 1000);
    h.disk.text = "ab\n";
    h.sync.changed();
    await vi.advanceTimersByTimeAsync(quietMs);
    expect(h.reloads).toEqual([]);
    await vi.advanceTimersByTimeAsync(shrinkHoldMs - 1000 - quietMs);
    expect(h.reloads).toEqual(["ab\n"]);
  });

  it("a shrink while dirty conflicts after the hold, not before", async () => {
    const h = harness("abcdef\n");
    edit(h, "abcdefg\n");
    h.disk.text = "";
    h.sync.changed();
    await vi.advanceTimersByTimeAsync(quietMs);
    expect(h.conflicts).toBe(0);
    await vi.advanceTimersByTimeAsync(shrinkHoldMs);
    expect(h.conflicts).toBe(1);
  });

  it("a failed read reports the error and changes nothing", async () => {
    const h = harness("a\n");
    const failing = createDocumentSync(
      "a\n",
      { read: () => Promise.reject(new Error("gone")), write: async () => {} },
      { serialize: () => "", reloaded: (t) => h.reloads.push(t), conflicted: () => {}, knownChanged: () => {}, failed: (e) => h.failures.push(e) },
      { setTimeout, clearTimeout: (x) => clearTimeout(x as ReturnType<typeof setTimeout>), now: Date.now },
    );
    failing.changed();
    await vi.advanceTimersByTimeAsync(quietMs);
    failing.edited();
    await vi.advanceTimersByTimeAsync(saveDelayMs);
    await failing.reload();
    expect(h.failures).toHaveLength(3);
    expect(h.reloads).toEqual([]);
    expect(failing.dirty).toBe(true);
  });

  it("dispose stops every timer and ignores later calls", async () => {
    const h = harness("a\n");
    edit(h, "ab\n");
    h.disk.text = "z\n";
    h.sync.changed();
    h.sync.dispose();
    h.sync.edited();
    h.sync.changed();
    expect(await h.sync.keepMine()).toBe("failed");
    await h.sync.reload();
    expect(await h.sync.flush()).toBe("failed");
    await h.sync.renamed();
    await vi.advanceTimersByTimeAsync(shrinkHoldMs * 2);
    expect(h.writes).toEqual([]);
    expect(h.reloads).toEqual([]);
    expect(h.conflicts).toBe(0);
  });
});

// DECISIONS #review-2-r0 U1, U6 (task 2.16): `flush` reports what it found, and every save, Keep
// mine and watcher check waits for the write in flight. One test per guard in the diff.
describe("flush results and the in-flight write", () => {
  it("flush during a conflict resolves conflict, keeps the edit dirty and writes nothing", async () => {
    const h = harness("a\n");
    edit(h, "ax\n");
    h.disk.text = "a\nb\n";
    h.sync.changed();
    await vi.advanceTimersByTimeAsync(quietMs);
    expect(h.sync.conflict).toBe(true);
    expect(await h.sync.flush()).toBe("conflict");
    expect(h.sync.dirty).toBe(true);
    expect(h.writes).toEqual([]);
    expect(h.disk.text).toBe("a\nb\n");
  });

  it("flush after a failed write resolves failed and keeps the edit dirty", async () => {
    const h = harness("a\n", DEFAULT_SYNC_OPTIONS, true);
    edit(h, "ab\n");
    await vi.advanceTimersByTimeAsync(saveDelayMs);
    expect(h.failures).toHaveLength(1);
    expect(await h.sync.flush()).toBe("failed");
    expect(h.sync.dirty).toBe(true);
    expect(h.disk.text).toBe("a\n");
  });

  it("flush while a write is in flight awaits it: no second read, no conflict, saved", async () => {
    const { wait, release } = gated();
    const h = harness("a\n", DEFAULT_SYNC_OPTIONS, false, wait);
    edit(h, "ab\n");
    await vi.advanceTimersByTimeAsync(saveDelayMs);
    expect(h.reads).toBe(1);
    expect(h.sync.dirty).toBe(true);
    let result: string | null = null;
    const flushed = h.sync.flush().then((r) => (result = r));
    await vi.advanceTimersByTimeAsync(0);
    expect(result).toBe(null);
    release();
    await flushed;
    expect(result).toBe("saved");
    expect(h.reads).toBe(1);
    expect(h.conflicts).toBe(0);
    expect(h.writes).toEqual(["ab\n"]);
    expect(h.sync.dirty).toBe(false);
  });

  it("a watcher report during an in-flight write is deferred, and the write's own echo reads as ours", async () => {
    const { wait, release } = gated();
    const h = harness("a\n", DEFAULT_SYNC_OPTIONS, false, wait);
    edit(h, "ab\n");
    await vi.advanceTimersByTimeAsync(saveDelayMs);
    h.sync.changed();
    await vi.advanceTimersByTimeAsync(quietMs * 4);
    // Deferred: the disk still holds the pre-write bytes, and a read now would call them a change.
    expect(h.reads).toBe(1);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.reads).toBe(2);
    expect(h.conflicts).toBe(0);
    expect(h.reloads).toEqual([]);
    expect(h.sync.dirty).toBe(false);
  });

  it("flush when clean resolves clean and writes nothing", async () => {
    const h = harness("a\n");
    expect(await h.sync.flush()).toBe("clean");
    expect(h.writes).toEqual([]);
    expect(h.reads).toBe(0);
  });

  it("keepMine during an in-flight write awaits it before its own write", async () => {
    const { wait, release } = gated();
    const h = harness("a\n", DEFAULT_SYNC_OPTIONS, false, wait);
    edit(h, "ab\n");
    await vi.advanceTimersByTimeAsync(saveDelayMs);
    edit(h, "abc\n");
    let result: string | null = null;
    const kept = h.sync.keepMine().then((r) => (result = r));
    await vi.advanceTimersByTimeAsync(0);
    expect(result).toBe(null);
    // Keep mine's own write has not started: it waits behind the one in flight.
    expect(h.started).toEqual(["ab\n"]);
    release();
    await kept;
    expect(result).toBe("saved");
    // In order: the in-flight write landed first, then Keep mine's.
    expect(h.writes).toEqual(["ab\n", "abc\n"]);
    expect(h.disk.text).toBe("abc\n");
    expect(h.sync.dirty).toBe(false);
  });

  it("flush of a dirty, idle document saves and resolves saved", async () => {
    const h = harness("a\n");
    edit(h, "ab\n");
    expect(await h.sync.flush()).toBe("saved");
    expect(h.disk.text).toBe("ab\n");
  });

  it("flush that finds the disk changed resolves conflict and writes nothing", async () => {
    const h = harness("a\n");
    edit(h, "ab\n");
    h.disk.text = "z\n";
    expect(await h.sync.flush()).toBe("conflict");
    expect(h.writes).toEqual([]);
    expect(h.sync.dirty).toBe(true);
  });

  it("flush that cannot read the disk resolves failed", async () => {
    const failures: unknown[] = [];
    const sync = createDocumentSync(
      "a\n",
      { read: () => Promise.reject(new Error("gone")), write: async () => {} },
      { serialize: () => "ab\n", reloaded: () => {}, conflicted: () => {}, knownChanged: () => {}, failed: (e) => failures.push(e) },
      { setTimeout, clearTimeout: (x) => clearTimeout(x as ReturnType<typeof setTimeout>), now: Date.now },
    );
    sync.edited();
    expect(await sync.flush()).toBe("failed");
    expect(sync.dirty).toBe(true);
    expect(failures).toHaveLength(1);
  });

  it("a watcher check deferred behind a write is dropped when a later report rescheduled it", async () => {
    const { wait, release } = gated();
    const h = harness("a\n", DEFAULT_SYNC_OPTIONS, false, wait);
    edit(h, "ab\n");
    await vi.advanceTimersByTimeAsync(saveDelayMs);
    h.sync.changed();
    await vi.advanceTimersByTimeAsync(quietMs);
    h.sync.changed();
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.reads).toBe(1);
    await vi.advanceTimersByTimeAsync(quietMs);
    expect(h.reads).toBe(2);
    expect(h.conflicts).toBe(0);
  });
});

describe("after a rename", () => {
  it("the same bytes as known change nothing", async () => {
    const h = harness("a\n");
    await h.sync.renamed();
    expect(h.reads).toBe(1);
    expect(h.reloads).toEqual([]);
    expect(h.known).toEqual([]);
  });

  it("rewritten bytes reload a clean document and never conflict", async () => {
    const h = harness("![](assets/a/x.png)\n");
    h.disk.text = "![](assets/b/x.png)\n";
    await h.sync.renamed();
    expect(h.reloads).toEqual(["![](assets/b/x.png)\n"]);
    expect(h.conflicts).toBe(0);
    edit(h, "![](assets/b/x.png)Q\n");
    await vi.advanceTimersByTimeAsync(saveDelayMs);
    expect(h.conflicts).toBe(0);
    expect(h.disk.text).toBe("![](assets/b/x.png)Q\n");
  });

  // DECISIONS #review-2-r2 W2 (task 2.27): the rename's rewrite reaches the dirty editor.
  it("rewritten image URLs under an edit reach the editor, stay dirty, and the next save writes the edit with the new stem", async () => {
    const h = harness("![image](assets/a/x.png)\n");
    edit(h, "![image](assets/a/x.png) later edit\n");
    h.disk.text = "![image](assets/b/x.png)\n";
    await h.sync.renamed((text) => rewriteAssetUrls(text, "a", "b"));
    expect(h.reloads).toEqual(["![image](assets/b/x.png) later edit\n"]);
    expect(h.editor.text).toBe("![image](assets/b/x.png) later edit\n");
    expect(h.sync.dirty).toBe(true);
    expect(h.conflicts).toBe(0);
    expect(h.known).toEqual(["![image](assets/b/x.png)\n"]);
    await vi.advanceTimersByTimeAsync(saveDelayMs);
    expect(h.conflicts).toBe(0);
    expect(h.disk.text).toBe("![image](assets/b/x.png) later edit\n");
    expect(h.disk.text).not.toContain("assets/a/");
    expect(h.sync.dirty).toBe(false);
  });

  it("an edit the rename's rewrite leaves alone is not handed back to the editor and stays dirty", async () => {
    const h = harness("a\n");
    edit(h, "aQ\n");
    h.disk.text = "b\n";
    await h.sync.renamed((text) => rewriteAssetUrls(text, "a", "b"));
    expect(h.reloads).toEqual([]);
    expect(h.sync.dirty).toBe(true);
    expect(h.conflicts).toBe(0);
    await vi.advanceTimersByTimeAsync(saveDelayMs);
    expect(h.disk.text).toBe("aQ\n");
  });

  it("a failed read reports the error and changes nothing", async () => {
    const failures: unknown[] = [];
    const reloads: string[] = [];
    const sync = createDocumentSync(
      "a\n",
      { read: () => Promise.reject(new Error("gone")), write: async () => {} },
      { serialize: () => "a\n", reloaded: (t) => reloads.push(t), conflicted: () => {}, knownChanged: () => {}, failed: (e) => failures.push(e) },
      { setTimeout, clearTimeout: (x) => clearTimeout(x as ReturnType<typeof setTimeout>), now: Date.now },
    );
    await sync.renamed();
    expect(failures).toHaveLength(1);
    expect(reloads).toEqual([]);
  });
});

// DECISIONS #review-2-r2 W1 (task 2.27): a barrier's `saved` covers an edit typed during its own
// write. Each case gates the barrier's first write and edits while it is in flight.
describe("a barrier drains an edit made during its write", () => {
  async function editDuringFlush(setup: (h: Harness) => void = () => {}) {
    const { wait, release } = gated();
    const h = harness("a\n", DEFAULT_SYNC_OPTIONS, false, wait);
    edit(h, "first\n");
    setup(h);
    let result: string | null = null;
    const flushed = h.sync.flush().then((r) => (result = r));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.started).toEqual(["first\n"]);
    edit(h, "first later\n");
    release();
    await flushed;
    return { h, result: result as string | null };
  }

  it("(1) an edit during flush's write: saved only after a second write, the later edit on disk", async () => {
    const { h, result } = await editDuringFlush();
    expect(result).toBe("saved");
    expect(h.writes).toEqual(["first\n", "first later\n"]);
    expect(h.disk.text).toBe("first later\n");
    expect(h.sync.dirty).toBe(false);
    expect(h.conflicts).toBe(0);
  });

  it("(2) another writer between the two writes: conflict, the later edit dirty, nothing written over the disk", async () => {
    const { h, result } = await editDuringFlush((h) => {
      h.afterWrite = () => {
        h.afterWrite = null;
        h.disk.text = "theirs\n";
      };
    });
    expect(result).toBe("conflict");
    expect(h.sync.conflict).toBe(true);
    expect(h.sync.dirty).toBe(true);
    expect(h.writes).toEqual(["first\n"]);
    expect(h.started).toEqual(["first\n"]);
    expect(h.disk.text).toBe("theirs\n");
    expect(h.editor.text).toBe("first later\n");
  });

  it("(3) the second write rejected: failed, the later edit dirty", async () => {
    const { h, result } = await editDuringFlush((h) => {
      h.afterWrite = () => {
        h.failWrite = true;
      };
    });
    expect(result).toBe("failed");
    expect(h.sync.dirty).toBe(true);
    expect(h.started).toEqual(["first\n", "first later\n"]);
    expect(h.writes).toEqual(["first\n"]);
    expect(h.disk.text).toBe("first\n");
    expect(h.failures).toHaveLength(1);
  });

  it("(4) disposed during the first write: no second write, failed", async () => {
    const { h, result } = await editDuringFlush((h) => {
      h.afterWrite = () => h.sync.dispose();
    });
    expect(result).toBe("failed");
    expect(h.started).toEqual(["first\n"]);
    expect(h.writes).toEqual(["first\n"]);
    expect(h.sync.dirty).toBe(true);
  });

  it("(4b) disposed during the drain's re-read: no second write, failed", async () => {
    const { wait, release } = gated();
    let reads = 0;
    const disk = { text: "a\n" };
    const editor = { text: "first\n" };
    const started: string[] = [];
    const sync = createDocumentSync(
      "a\n",
      {
        read: async () => {
          reads += 1;
          // The drain's re-read (the second read): the pane unmounts while it is pending.
          if (reads === 2) sync.dispose();
          return disk.text;
        },
        write: async (text) => {
          started.push(text);
          await wait;
          disk.text = text;
        },
      },
      { serialize: () => editor.text, reloaded: () => {}, conflicted: () => {}, knownChanged: () => {}, failed: () => {} },
      { setTimeout, clearTimeout: (x) => clearTimeout(x as ReturnType<typeof setTimeout>), now: Date.now },
    );
    sync.edited();
    const flushed = sync.flush();
    await vi.advanceTimersByTimeAsync(0);
    editor.text = "first later\n";
    sync.edited();
    release();
    expect(await flushed).toBe("failed");
    expect(reads).toBe(2);
    expect(started).toEqual(["first\n"]);
    expect(sync.dirty).toBe(true);
  });

  it("(5) keepMine with an edit during its write: saved only after the later edit is on disk", async () => {
    const { wait, release } = gated();
    const h = harness("a\n", DEFAULT_SYNC_OPTIONS, false, wait);
    edit(h, "mine\n");
    h.disk.text = "theirs\n";
    h.sync.changed();
    await vi.advanceTimersByTimeAsync(quietMs);
    expect(h.sync.conflict).toBe(true);
    let result: string | null = null;
    const kept = h.sync.keepMine().then((r) => (result = r));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.started).toEqual(["mine\n"]);
    edit(h, "mine later\n");
    release();
    await kept;
    expect(result).toBe("saved");
    expect(h.writes).toEqual(["mine\n", "mine later\n"]);
    expect(h.disk.text).toBe("mine later\n");
    expect(h.sync.dirty).toBe(false);
    expect(h.sync.conflict).toBe(false);
  });

  it("(6) flush with no edit during its own write: exactly one write", async () => {
    const { wait, release } = gated();
    const h = harness("a\n", DEFAULT_SYNC_OPTIONS, false, wait);
    edit(h, "first\n");
    let result: string | null = null;
    const flushed = h.sync.flush().then((r) => (result = r));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.started).toEqual(["first\n"]);
    release();
    await flushed;
    await vi.advanceTimersByTimeAsync(saveDelayMs * 2);
    expect(result).toBe("saved");
    expect(h.started).toEqual(["first\n"]);
    expect(h.writes).toEqual(["first\n"]);
    expect(h.reads).toBe(1);
    expect(h.sync.dirty).toBe(false);
  });
});
