import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
}

function harness(initial: string, options = DEFAULT_SYNC_OPTIONS, failWrite = false): Harness {
  const h: Omit<Harness, "sync"> = {
    disk: { text: initial },
    editor: { text: initial },
    writes: [],
    reloads: [],
    conflicts: 0,
    known: [],
    failures: [],
  };
  const sync = createDocumentSync(
    initial,
    {
      read: async () => h.disk.text,
      write: async (text) => {
        if (failWrite) throw new Error("disk full");
        h.writes.push(text);
        h.disk.text = text;
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
    await h.sync.keepMine();
    await h.sync.reload();
    await h.sync.flush();
    await vi.advanceTimersByTimeAsync(shrinkHoldMs * 2);
    expect(h.writes).toEqual([]);
    expect(h.reloads).toEqual([]);
    expect(h.conflicts).toBe(0);
  });
});
