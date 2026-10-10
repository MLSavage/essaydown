import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "../apps/desktop/node_modules/@tauri-apps/api/core.js";
import type { Root } from "mdast";
import { rewriteAssetUrls } from "../packages/core/src/assets.js";
import { format } from "../packages/core/src/format.js";
import { parse } from "../packages/core/src/parse.js";
import { candidatesOf, emptySidecar, parseSidecar, type Sidecar } from "../packages/core/src/sidecar.js";
import { bindCodeMirror, type BoundSourceView, type DocumentStore, type SourceBinding } from "../packages/editor/src/index.js";
import { decideClose } from "../apps/desktop/src/workspace/close-guard.js";
import { createPaneSync, loadDocument, storeFor, type PaneSync } from "../apps/desktop/src/workspace/DocumentPane.js";
import { exportDocument, type ExportArgs, type ExportIO } from "../apps/desktop/src/workspace/export-sync.js";
import { sidecarPathFor } from "../apps/desktop/src/workspace/paths.js";
import {
  createDocumentSync,
  DEFAULT_SYNC_OPTIONS,
  MarkdownWritten,
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

  it("a write whose Markdown landed and whose sidecar failed keeps known on the written text: the retry writes, no conflict", async () => {
    const h = harness("a\n");
    let sidecarFails = true;
    const sidecar = new Error("sidecar: permission denied");
    const sync = createDocumentSync(
      "a\n",
      {
        read: async () => h.disk.text,
        write: async (text) => {
          h.disk.text = text;
          h.writes.push(text);
          if (sidecarFails) throw new MarkdownWritten(sidecar);
        },
      },
      {
        serialize: () => h.editor.text,
        reloaded: () => {},
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
    );
    h.editor.text = "ab\n";
    sync.edited();
    expect(await sync.flush()).toBe("failed");
    // The sidecar's own error is reported, and `known` was not put back to the pre-write bytes.
    expect(h.failures).toEqual([sidecar]);
    expect(h.known).toEqual(["ab\n"]);
    expect(sync.dirty).toBe(true);
    sidecarFails = false;
    expect(await sync.flush()).toBe("saved");
    expect(h.conflicts).toBe(0);
    expect(sync.conflict).toBe(false);
    expect(h.writes).toEqual(["ab\n", "ab\n"]);
    expect(sync.dirty).toBe(false);
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
    let moves = 0;
    expect(await h.sync.renamed((t) => t, async () => void (moves += 1))).toEqual({ moved: false, result: "failed" });
    expect(moves).toBe(0);
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

// Task 3.11 (DECISIONS #review-2-r3): the rename runs inside the chain — barrier, move, re-read,
// rewrite and its write in one operation. `h.disk` is the one file; `move` stands for
// `rename_file` (the bytes are unchanged unless the case says another writer touched them). One
// test per guard `renamed` adds.
const toB = (text: string): string => rewriteAssetUrls(text, "a", "b");

describe("after a rename", () => {
  it("the same bytes as known with nothing to rewrite change nothing", async () => {
    const h = harness("a\n");
    let moves = 0;
    expect(await h.sync.renamed(toB, async () => void (moves += 1))).toEqual({ moved: true, result: "clean" });
    expect(moves).toBe(1);
    expect(h.reads).toBe(1);
    expect(h.writes).toEqual([]);
    expect(h.reloads).toEqual([]);
    expect(h.known).toEqual([]);
  });

  it("a clean document's image URLs are rewritten from the disk's own bytes, reloaded and written, never a conflict", async () => {
    // Non-canonical bytes (`*` emphasis) stay as they are: the clean rewrite is the disk's, not the editor's format.
    const h = harness("*e* ![](assets/a/x.png)\n");
    expect(await h.sync.renamed(toB, async () => {})).toEqual({ moved: true, result: "saved" });
    expect(h.reloads).toEqual(["*e* ![](assets/b/x.png)\n"]);
    expect(h.writes).toEqual(["*e* ![](assets/b/x.png)\n"]);
    expect(h.sync.dirty).toBe(false);
    edit(h, "*e* ![](assets/b/x.png)Q\n");
    await vi.advanceTimersByTimeAsync(saveDelayMs);
    expect(h.conflicts).toBe(0);
    expect(h.disk.text).toBe("*e* ![](assets/b/x.png)Q\n");
  });

  it("a clean document changed by another writer during the move reloads the new bytes", async () => {
    const h = harness("a\n");
    const outcome = await h.sync.renamed(toB, async () => void (h.disk.text = "z\n"));
    expect(outcome).toEqual({ moved: true, result: "clean" });
    expect(h.reloads).toEqual(["z\n"]);
    expect(h.known).toEqual(["z\n"]);
    expect(h.writes).toEqual([]);
  });

  it("a pending edit is saved at the old path before the move, and the move waits for it", async () => {
    const h = harness("![image](assets/a/x.png)\n");
    edit(h, "![image](assets/a/x.png) later edit\n");
    const order: string[] = [];
    h.afterWrite = () => order.push(`write ${h.disk.text}`);
    await h.sync.renamed(toB, async () => void order.push("move"));
    expect(order).toEqual([
      "write ![image](assets/a/x.png) later edit\n",
      "move",
      "write ![image](assets/b/x.png) later edit\n",
    ]);
    expect(h.editor.text).toBe("![image](assets/b/x.png) later edit\n");
    expect(h.sync.dirty).toBe(false);
  });

  it("refused with a conflict standing: nothing moves", async () => {
    const h = harness("a\n");
    edit(h, "ab\n");
    h.disk.text = "z\n";
    h.sync.changed();
    await vi.advanceTimersByTimeAsync(quietMs);
    expect(h.sync.conflict).toBe(true);
    let moves = 0;
    expect(await h.sync.renamed(toB, async () => void (moves += 1))).toEqual({ moved: false, result: "conflict" });
    expect(moves).toBe(0);
  });

  it("refused when the barrier's save finds the disk changed: conflict, nothing moves", async () => {
    const h = harness("a\n");
    edit(h, "ab\n");
    h.disk.text = "z\n";
    let moves = 0;
    expect(await h.sync.renamed(toB, async () => void (moves += 1))).toEqual({ moved: false, result: "conflict" });
    expect(moves).toBe(0);
    expect(h.writes).toEqual([]);
  });

  it("refused when the barrier's save fails: failed, nothing moves, the edit dirty", async () => {
    const h = harness("a\n", DEFAULT_SYNC_OPTIONS, true);
    edit(h, "ab\n");
    let moves = 0;
    expect(await h.sync.renamed(toB, async () => void (moves += 1))).toEqual({ moved: false, result: "failed" });
    expect(moves).toBe(0);
    expect(h.sync.dirty).toBe(true);
  });

  it("a move that rejects is rethrown, and nothing is read or written after it", async () => {
    const h = harness("![](assets/a/x.png)\n");
    await expect(h.sync.renamed(toB, () => Promise.reject(new Error("exists")))).rejects.toThrow("exists");
    expect(h.reads).toBe(0);
    expect(h.writes).toEqual([]);
    // The chain is not broken: a later save still runs.
    edit(h, "![](assets/a/x.png)Q\n");
    await vi.advanceTimersByTimeAsync(saveDelayMs);
    expect(h.disk.text).toBe("![](assets/a/x.png)Q\n");
  });

  it("a failed read after the move reports the error: moved, failed, nothing written", async () => {
    const failures: unknown[] = [];
    const reloads: string[] = [];
    const sync = createDocumentSync(
      "a\n",
      { read: () => Promise.reject(new Error("gone")), write: async () => {} },
      { serialize: () => "a\n", reloaded: (t) => reloads.push(t), conflicted: () => {}, knownChanged: () => {}, failed: (e) => failures.push(e) },
      { setTimeout, clearTimeout: (x) => clearTimeout(x as ReturnType<typeof setTimeout>), now: Date.now },
    );
    expect(await sync.renamed(toB, async () => {})).toEqual({ moved: true, result: "failed" });
    expect(failures).toHaveLength(1);
    expect(reloads).toEqual([]);
  });

  it("disposed during the read after the move: an edit made during the move is reported failed, not written", async () => {
    const h = harness("a\n");
    const outcome = h.sync.renamed(toB, async () => {
      edit(h, "ab\n");
      h.sync.dispose();
    });
    expect(await outcome).toEqual({ moved: true, result: "failed" });
    expect(h.writes).toEqual([]);
  });

  it("disposed during the move: clean when nothing was edited", async () => {
    const h = harness("a\n");
    expect(await h.sync.renamed(toB, async () => h.sync.dispose())).toEqual({ moved: true, result: "clean" });
    expect(h.writes).toEqual([]);
  });

  it("an edit during the move that the rewrite leaves alone is written at the new path, not handed back", async () => {
    const h = harness("a\n");
    expect(await h.sync.renamed(toB, async () => edit(h, "aQ\n"))).toEqual({ moved: true, result: "saved" });
    expect(h.reloads).toEqual([]);
    expect(h.disk.text).toBe("aQ\n");
    expect(h.sync.dirty).toBe(false);
  });

  // DECISIONS #review-2-r2 W2 (task 2.27), kept: the rename's rewrite reaches the dirty editor.
  it("an edit during the move has its image URLs rewritten in the editor and on disk", async () => {
    const h = harness("![image](assets/a/x.png)\n");
    const outcome = await h.sync.renamed(toB, async () => edit(h, "![image](assets/a/x.png) later edit\n"));
    expect(outcome).toEqual({ moved: true, result: "saved" });
    expect(h.reloads).toEqual(["![image](assets/b/x.png) later edit\n"]);
    expect(h.disk.text).toBe("![image](assets/b/x.png) later edit\n");
    expect(h.disk.text).not.toContain("assets/a/");
    expect(h.sync.dirty).toBe(false);
    expect(h.conflicts).toBe(0);
  });

  // The checked outcome covers the latest generation (DECISIONS #review-2-r2 W1): the edit lands
  // during the rewrite's own awaited write.
  it("an edit during the rewrite's write: saved only after the later edit is on disk", async () => {
    const { wait, release } = gated();
    const h = harness("![](assets/a/x.png)\n", DEFAULT_SYNC_OPTIONS, false, wait);
    let result: unknown = null;
    const renamed = h.sync.renamed(toB, async () => {}).then((r) => (result = r));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.started).toEqual(["![](assets/b/x.png)\n"]);
    edit(h, "![](assets/b/x.png) later\n");
    release();
    await renamed;
    expect(result).toEqual({ moved: true, result: "saved" });
    expect(h.writes).toEqual(["![](assets/b/x.png)\n", "![](assets/b/x.png) later\n"]);
    expect(h.sync.dirty).toBe(false);
  });

  it("a failed rewrite write: moved, failed, the rewrite kept dirty in the editor", async () => {
    const h = harness("![](assets/a/x.png)\n");
    h.failWrite = true;
    expect(await h.sync.renamed(toB, async () => {})).toEqual({ moved: true, result: "failed" });
    expect(h.editor.text).toBe("![](assets/b/x.png)\n");
    expect(h.sync.dirty).toBe(true);
    h.failWrite = false;
    expect(await h.sync.flush()).toBe("saved");
    expect(h.disk.text).toBe("![](assets/b/x.png)\n");
  });

  // The missing guard `[review-2-r3, rename read-then-write]` names: `renamed` with a conflict
  // standing after the move. Another writer changed the file while an edit was pending; the edit is
  // kept with the new stem behind the banner, and Keep mine writes the new stem.
  it("renamed with a conflict standing: Keep mine writes asset URLs under the new stem", async () => {
    const h = harness("![image](assets/a/x.png)\n");
    const outcome = await h.sync.renamed(toB, async () => {
      edit(h, "![image](assets/a/x.png) mine\n");
      h.disk.text = "![image](assets/b/x.png) theirs\n";
    });
    expect(outcome).toEqual({ moved: true, result: "conflict" });
    expect(h.sync.conflict).toBe(true);
    expect(h.conflicts).toBe(1);
    expect(h.writes).toEqual([]);
    expect(h.editor.text).toBe("![image](assets/b/x.png) mine\n");
    expect(await h.sync.keepMine()).toBe("saved");
    expect(h.disk.text).toBe("![image](assets/b/x.png) mine\n");
    expect(h.disk.text).not.toContain("assets/a/");
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

// Task 3.24 (DECISIONS #review-3-r0 S1, S3; Sol r0 findings 1 and 3): the pane's own save path —
// `createPaneSync` out of DocumentPane.tsx, over a real document store and a source binding — with
// Tauri's `invoke` mocked as a map of files. `type` is CodeMirror's update listener (the burst is
// pending in the binding until its window ends); `reloaded` swaps the store the way the pane's
// effects do: the old store's subscriber goes first, then the old binding's `destroy` flushes into
// the discarded store, then the new store is subscribed and bound.

const ipc = vi.hoisted(() => ({
  files: new Map<string, string>(),
  /** A command held until its gate is released; consumed by the first call. */
  holds: new Map<string, Promise<void>>(),
}));

// By path: `@tauri-apps/api` is the desktop app's dependency, so a bare specifier from tests/ names
// another module id than the one DocumentPane.tsx imports, and the mock would not apply.
vi.mock("../apps/desktop/node_modules/@tauri-apps/api/core.js", () => ({
  invoke: async (command: string, args: { path?: string; contents?: string }) => {
    const hold = ipc.holds.get(command);
    if (hold !== undefined) {
      ipc.holds.delete(command);
      await hold;
    }
    const path = args.path ?? "";
    switch (command) {
      case "read_doc": {
        const text = ipc.files.get(path);
        if (text === undefined) throw new Error(`not found: ${path}`);
        return text;
      }
      case "read_sidecar":
        return ipc.files.get(path) ?? null;
      case "write_doc":
      case "write_sidecar":
        ipc.files.set(path, args.contents ?? "");
        return null;
      default:
        throw new Error(`unexpected command ${command}`);
    }
  },
}));
vi.mock("../apps/desktop/node_modules/@tauri-apps/api/event.js", () => ({ listen: async () => () => {} }));

const DOC = "essay.md";
const SIDECAR = sidecarPathFor(DOC);
const { coalesceWindowMs } = storeFor("", emptySidecar()).getState().stack;

/** A CodeMirror view as `bindCodeMirror` reads it: the buffer's text, replaced whole. */
class Buffer {
  text = "";
  readonly view: BoundSourceView = {
    get state() {
      return { doc: { toString: () => buffer.text, length: buffer.text.length } } as unknown as BoundSourceView["state"];
    },
    dispatch: (spec) => {
      const changes = spec.changes as { insert: string };
      this.text = changes.insert;
    },
  };
}
let buffer = new Buffer();

interface Pane {
  readonly sync: PaneSync;
  store(): DocumentStore;
  /** The source view's buffer. */
  buffer(): string;
  /** Type into the source view: the binding records a burst it commits a window later. */
  type(text: string): void;
  banner: boolean;
  reloads: number;
  errors: string[];
}

async function openPane(text: string, sidecarRaw: string | null = null): Promise<Pane> {
  ipc.files.clear();
  ipc.holds.clear();
  ipc.files.set(DOC, text);
  if (sidecarRaw !== null) ipc.files.set(SIDECAR, sidecarRaw);
  const initial = await loadDocument(DOC);
  buffer = new Buffer();
  let store = storeFor(initial.text, initial.sidecar);
  let path = DOC;
  let unsubscribe: () => void = () => {};
  let binding: SourceBinding | null = null;
  const mount = (): void => {
    unsubscribe = store.subscribe((state, previous) => pane.sync.storeChanged(state, previous));
    binding = bindCodeMirror(store, buffer.view);
  };
  const pane: Pane = {
    sync: createPaneSync(initial, {
      store: () => store,
      path: () => path,
      moved: (next) => {
        path = next;
      },
      replaced: (next) => {
        unsubscribe();
        binding?.destroy();
        store = next;
        pane.reloads += 1;
        mount();
      },
      banner: (shown) => {
        pane.banner = shown;
      },
      knownChanged: () => {},
      error: (message) => pane.errors.push(message),
    }),
    store: () => store,
    buffer: () => buffer.text,
    type(next) {
      buffer.text = next;
      binding?.change(next);
    },
    banner: false,
    reloads: 0,
    errors: [],
  };
  mount();
  return pane;
}

const textOf = (pane: Pane): string => format(pane.store().getState().document.root);

describe("the watcher settles a pending source burst (S1, through the pane)", () => {
  it("guard 1: an external change inside the source window after typing → the banner, and the buffer and the store keep LOCAL", async () => {
    const pane = await openPane("Alpha.\n");
    pane.type("Alpha.LOCAL\n");
    ipc.files.set(DOC, "Alpha.\n\nExternal.\n");
    pane.sync.sync.changed();
    await vi.advanceTimersByTimeAsync(quietMs);
    // Still inside the window: only the check's own settle can have committed the burst.
    expect(quietMs).toBeLessThan(coalesceWindowMs);
    expect(pane.banner).toBe(true);
    expect(pane.reloads).toBe(0);
    expect(pane.buffer()).toBe("Alpha.LOCAL\n");
    expect(textOf(pane)).toBe("Alpha.LOCAL\n");
    expect(pane.sync.sync.dirty).toBe(true);
    // Nothing was written over the other writer's text.
    await vi.advanceTimersByTimeAsync(coalesceWindowMs + saveDelayMs);
    expect(ipc.files.get(DOC)).toBe("Alpha.\n\nExternal.\n");
  });

  it("guard 2: the typing lands during the watcher's awaited read → the banner, and the buffer and the store keep LOCAL", async () => {
    const pane = await openPane("Alpha.\n");
    ipc.files.set(DOC, "Alpha.\n\nExternal.\n");
    let release: () => void = () => {};
    ipc.holds.set("read_doc", new Promise<void>((resolve) => (release = resolve)));
    pane.sync.sync.changed();
    await vi.advanceTimersByTimeAsync(quietMs);
    // The check is waiting on its read; nothing was pending when it started.
    expect(ipc.holds.has("read_doc")).toBe(false);
    pane.type("Alpha.LOCAL\n");
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(pane.banner).toBe(true);
    expect(pane.reloads).toBe(0);
    expect(pane.buffer()).toBe("Alpha.LOCAL\n");
    expect(textOf(pane)).toBe("Alpha.LOCAL\n");
  });

  it("guard 3: Keep mine inside the window → the disk holds the pending text", async () => {
    const pane = await openPane("Alpha.\n");
    pane.type("Alpha.ONE\n");
    ipc.files.set(DOC, "Alpha.\n\nExternal.\n");
    pane.sync.sync.changed();
    await vi.advanceTimersByTimeAsync(quietMs);
    expect(pane.banner).toBe(true);
    pane.type("Alpha.ONE TWO\n");
    const result = await pane.sync.sync.keepMine();
    expect(result).toBe("saved");
    expect(ipc.files.get(DOC)).toBe("Alpha.ONE TWO\n");
    expect(pane.sync.sync.dirty).toBe(false);
  });

  it("guard 4 (absence): no pending burst → the external change reloads silently, as before", async () => {
    const pane = await openPane("Alpha.\n");
    ipc.files.set(DOC, "Alpha.\n\nExternal.\n");
    pane.sync.sync.changed();
    await vi.advanceTimersByTimeAsync(quietMs);
    expect(pane.banner).toBe(false);
    expect(pane.reloads).toBe(1);
    expect(textOf(pane)).toBe("Alpha.\n\nExternal.\n");
    expect(pane.buffer()).toBe("Alpha.\n\nExternal.\n");
    expect(pane.sync.sync.dirty).toBe(false);
  });

  it("guard 5 (export, C7): exporting inside the window reads the typed burst, not the stale disk text", async () => {
    const pane = await openPane("Alpha.\n");
    pane.type("Alpha.LOCAL\n");
    // Still inside the window: only export's own flush (through the pane's `flush`, which settles
    // the store before `sync.flush`) can have committed the burst.
    expect(quietMs).toBeLessThan(coalesceWindowMs);
    const runArgs: ExportArgs[] = [];
    const io: ExportIO = {
      flush: () => pane.sync.flush(),
      readDoc: (path) => invoke<string>("read_doc", { path }),
      runExport: async (args) => {
        runArgs.push(args);
        return { outPath: args.outPath, warning: null };
      },
      reveal: async () => {},
    };
    const result = await exportDocument(io, DOC, "essay.docx", "docx");
    expect(result.status).toBe("exported");
    expect(runArgs[0]?.contents).toContain("LOCAL");
  });
});

const WRITTEN_SIDECAR = `${JSON.stringify(emptySidecar(), null, 2)}\n`;
const VARIANT = { text: "Alpha, once more.", createdAt: "2026-10-06T00:00:00.000Z" };

/** Type `Alpha. Beta.` and add one Rewrite variant on its first sentence, as two store commits. */
function editWithVariant(pane: Pane): void {
  const state = pane.store().getState();
  const root: Root = parse("Alpha. Beta.\n");
  state.commit(root, state.document.sidecar);
  const candidate = candidatesOf(root).find((one) => one.kind === "sentence");
  if (candidate === undefined) throw new Error("no sentence candidate");
  const anchor = {
    kind: candidate.kind,
    hash: candidate.hash,
    occurrence: candidate.occurrence,
    text: candidate.text,
    sectionHash: candidate.sectionHash,
    blockHash: candidate.blockHash,
    depth: candidate.depth,
    pos: [...candidate.pos],
  };
  pane.store().getState().dispatch((document) => ({
    root: document.root,
    sidecar: { ...document.sidecar, rewrites: [{ anchor, variants: [VARIANT], chosen: null, history: [] }] },
  }));
}

const variantsOf = (sidecar: Sidecar): string[] => sidecar.rewrites.flatMap((entry) => entry.variants.map((v) => v.text));

describe("a sidecar that was not written is a failed save (S3, through the pane)", () => {
  async function broken(): Promise<Pane> {
    const pane = await openPane("Alpha.\n", WRITTEN_SIDECAR);
    editWithVariant(pane);
    ipc.files.set(SIDECAR, "{broken");
    return pane;
  }

  it("guard 5: a malformed disk sidecar and an in-memory variant → flush is failed, the Markdown is written, the variant retained", async () => {
    const pane = await broken();
    const store = pane.store();
    expect(await pane.sync.flush()).toBe("failed");
    expect(ipc.files.get(DOC)).toBe("Alpha. Beta.\n");
    expect(ipc.files.get(SIDECAR)).toBe("{broken");
    expect(pane.sync.sync.dirty).toBe(true);
    expect(pane.store()).toBe(store);
    expect(variantsOf(store.getState().document.sidecar)).toEqual([VARIANT.text]);
    expect(pane.errors.at(-1)).toContain(`${SIDECAR} was not saved`);
    // The Markdown baseline is the written text: the next save finds no other writer.
    expect(pane.banner).toBe(false);
    expect(await pane.sync.flush()).toBe("failed");
    expect(pane.banner).toBe(false);
  });

  it("guard 6a: a switch stays on the document — the flush it awaits is failed, and the store keeps the variant", async () => {
    const pane = await broken();
    const store = pane.store();
    // App.tsx's `openFile` proceeds only on `clean` or `saved` (its private `switchWaits`).
    const result = await pane.sync.flush();
    expect(["clean", "saved"]).not.toContain(result);
    expect(pane.store()).toBe(store);
    expect(variantsOf(pane.store().getState().document.sidecar)).toEqual([VARIANT.text]);
  });

  it("guard 6b: a close stays on the document — decideClose of the flush is stay", async () => {
    const pane = await broken();
    expect(decideClose(await pane.sync.flush())).toEqual({
      action: "stay",
      waits: "Not closed: this document is not saved yet.",
    });
    expect(variantsOf(pane.store().getState().document.sidecar)).toEqual([VARIANT.text]);
  });

  it("guard 6c: a rename stays on the document — nothing moves, and the outcome is failed", async () => {
    const pane = await broken();
    const move = vi.fn(async () => {});
    expect(await pane.sync.rename("renamed.md", move)).toEqual({ moved: false, result: "failed" });
    expect(move).not.toHaveBeenCalled();
    expect(ipc.files.has(DOC)).toBe(true);
    expect(variantsOf(pane.store().getState().document.sidecar)).toEqual([VARIANT.text]);
  });

  it("guard 7: after the sidecar is repaired on disk the next save writes it, and the variant survives a reload", async () => {
    const pane = await broken();
    expect(await pane.sync.flush()).toBe("failed");
    ipc.files.set(SIDECAR, WRITTEN_SIDECAR);
    expect(await pane.sync.flush()).toBe("saved");
    expect(pane.sync.sync.dirty).toBe(false);
    expect(variantsOf(parseSidecar(JSON.parse(ipc.files.get(SIDECAR) ?? "null")))).toEqual([VARIANT.text]);
    const reloaded = await loadDocument(DOC);
    expect(reloaded.text).toBe("Alpha. Beta.\n");
    expect(variantsOf(storeFor(reloaded.text, reloaded.sidecar).getState().document.sidecar)).toEqual([VARIANT.text]);
  });

  it("guard 8 (absence): a well-formed disk sidecar → flush is saved, with the variant on disk", async () => {
    const pane = await openPane("Alpha.\n", WRITTEN_SIDECAR);
    editWithVariant(pane);
    expect(await pane.sync.flush()).toBe("saved");
    expect(ipc.files.get(DOC)).toBe("Alpha. Beta.\n");
    expect(variantsOf(parseSidecar(JSON.parse(ipc.files.get(SIDECAR) ?? "null")))).toEqual([VARIANT.text]);
    expect(pane.errors).toEqual([]);
  });
});

// Task 4.8 (#review-3-r1, Claude r1 riskiest thing 2): a source burst typed while the barrier's
// IPC is in flight. The pane's `flush` and `rename` settle once, before the sync's chain; each
// leg below types inside the awaited write or move, still inside the source window, so only a
// settle inside the chain can commit the burst before the outcome is decided.

/** Hold `command`'s next call until `release`; `started` is true once the call is waiting. */
function hold(command: string): { release: () => void; started: () => boolean } {
  let release: () => void = () => {};
  ipc.holds.set(command, new Promise<void>((resolve) => (release = resolve)));
  return { release: () => release(), started: () => !ipc.holds.has(command) };
}

describe("a source burst during the barrier's awaited IPC is on disk before saved (task 4.8)", () => {
  it("reproduction 1 (drain): typing during the flush's held write → saved only with the typed text on disk", async () => {
    const pane = await openPane("Alpha.\n");
    pane.type("Alpha.ONE\n");
    const write = hold("write_doc");
    const flushed = pane.sync.flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(write.started()).toBe(true);
    pane.type("Alpha.ONE TWO\n");
    write.release();
    const result = await flushed;
    // Still inside the window: only a settle inside the drain can have committed the burst.
    expect(result).toBe("saved");
    expect(ipc.files.get(DOC)).toBe("Alpha.ONE TWO\n");
    expect(pane.sync.sync.dirty).toBe(false);
  });

  it("reproduction 2 (rename): typing during the rename's held move → the typed text is at the new path before the outcome", async () => {
    const pane = await openPane("Alpha.\n");
    pane.type("Alpha.ONE\n");
    let release: () => void = () => {};
    let moving = false;
    const move = async (): Promise<void> => {
      moving = true;
      await new Promise<void>((resolve) => (release = resolve));
      const text = ipc.files.get(DOC);
      if (text === undefined) throw new Error("nothing to move");
      ipc.files.delete(DOC);
      ipc.files.set("renamed.md", text);
    };
    const renamed = pane.sync.rename("renamed.md", move);
    await vi.advanceTimersByTimeAsync(0);
    expect(moving).toBe(true);
    expect(ipc.files.get(DOC)).toBe("Alpha.ONE\n");
    pane.type("Alpha.ONE TWO\n");
    release();
    const outcome = await renamed;
    expect(outcome).toEqual({ moved: true, result: "saved" });
    expect(ipc.files.get("renamed.md")).toBe("Alpha.ONE TWO\n");
    expect(pane.sync.sync.dirty).toBe(false);
  });

  it("guard (flush after the in-flight write): typing while flush waits behind an autosave's held write → saved only with the typed text on disk", async () => {
    const pane = await openPane("Alpha.\n");
    pane.type("Alpha.ONE\n");
    const write = hold("write_doc");
    // The burst commits at the end of its window, and the autosave starts its (held) write.
    await vi.advanceTimersByTimeAsync(coalesceWindowMs + saveDelayMs);
    expect(write.started()).toBe(true);
    const flushed = pane.sync.flush();
    await vi.advanceTimersByTimeAsync(0);
    pane.type("Alpha.ONE TWO\n");
    write.release();
    const result = await flushed;
    expect(result).toBe("saved");
    expect(ipc.files.get(DOC)).toBe("Alpha.ONE TWO\n");
    expect(pane.sync.sync.dirty).toBe(false);
  });

  it("absence: no burst during the held write → saved with the barrier's text, and one write", async () => {
    const pane = await openPane("Alpha.\n");
    pane.type("Alpha.ONE\n");
    const write = hold("write_doc");
    const flushed = pane.sync.flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(write.started()).toBe(true);
    write.release();
    expect(await flushed).toBe("saved");
    expect(ipc.files.get(DOC)).toBe("Alpha.ONE\n");
    expect(pane.sync.sync.dirty).toBe(false);
  });
});
