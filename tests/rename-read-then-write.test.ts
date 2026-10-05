import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rewriteAssetUrls } from "../packages/core/src/assets.js";
import { createDocumentSync, DEFAULT_SYNC_OPTIONS, type DocumentSync } from "../apps/desktop/src/workspace/document-sync.js";

// Task 3.11 (DECISIONS #review-2-r3, `[review-2-r3, rename read-then-write]`): an edit that lands
// after the rename's flush and autosaves while the rename's IPC is in flight must reach the bytes
// at the new path and stay in the editor. The IPC is a map of files; `read_doc` and `rename_file`
// are held by gates the test releases, so the edit and its autosave land inside the window.

const { saveDelayMs } = DEFAULT_SYNC_OPTIONS;

interface Gate {
  wait: Promise<void>;
  release: () => void;
}

function gate(): Gate {
  let release: () => void = () => {};
  const wait = new Promise<void>((resolve) => (release = resolve));
  return { wait, release };
}

interface Ipc {
  files: Map<string, string>;
  /** Each IPC name holds while its gate is set; the gate is consumed by the first call. */
  holds: Map<string, Gate>;
  /** Every IPC as it starts. */
  calls: string[];
  readDoc(path: string): Promise<string>;
  writeDoc(path: string, contents: string): Promise<void>;
  renameFile(oldPath: string, newPath: string, rewritten?: string): Promise<void>;
}

function ipc(files: Record<string, string>): Ipc {
  const it: Ipc = {
    files: new Map(Object.entries(files)),
    holds: new Map(),
    calls: [],
    async readDoc(path) {
      it.calls.push(`read_doc ${path}`);
      await held("read_doc");
      const text = it.files.get(path);
      if (text === undefined) throw new Error(`not found: ${path}`);
      return text;
    },
    async writeDoc(path, contents) {
      it.calls.push(`write_doc ${path}`);
      await held("write_doc");
      it.files.set(path, contents);
    },
    // `rename_file_at` (workspace.rs): the doc moves, then `rewritten` is installed over it.
    async renameFile(oldPath, newPath, rewritten) {
      it.calls.push(`rename_file ${oldPath} ${newPath}`);
      await held("rename_file");
      const text = it.files.get(oldPath);
      if (text === undefined) throw new Error(`not found: ${oldPath}`);
      it.files.delete(oldPath);
      it.files.set(newPath, rewritten ?? text);
    },
  };
  async function held(name: string): Promise<void> {
    const g = it.holds.get(name);
    if (g === undefined) return;
    it.holds.delete(name);
    await g.wait;
  }
  return it;
}

/** The pane: one editor text, one sync whose I/O reads `path` at call time (DocumentPane.tsx). */
interface Pane {
  path: string;
  editor: { text: string };
  sync: DocumentSync;
  edit(text: string): void;
}

function pane(io: Ipc, path: string): Pane {
  const initial = io.files.get(path) ?? "";
  const p: Omit<Pane, "sync"> = {
    path,
    editor: { text: initial },
    edit: (text) => {
      p.editor.text = text;
      sync.edited();
    },
  };
  const sync = createDocumentSync(
    initial,
    { read: () => io.readDoc(p.path), write: (text) => io.writeDoc(p.path, text) },
    {
      serialize: () => p.editor.text,
      reloaded: (text) => {
        p.editor.text = text;
      },
      conflicted: () => {},
      knownChanged: () => {},
      failed: () => {},
    },
    {
      setTimeout: (callback, ms) => setTimeout(callback, ms),
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      now: () => Date.now(),
    },
  );
  return Object.assign(p, { sync });
}

/**
 * `commitRename` (App.tsx) for the open document, through `DocumentPaneHandle.rename`: the sync's
 * `renamed` runs the barrier, `rename_file` without `rewritten`, the pane's path move, the re-read
 * and the rewrite's write in one operation of its chain.
 *
 * At the branch base this was: `flush`, `read_doc` the old path, `rename_file` with the rewritten
 * bytes, move the pane's path, then `renamed(rewrite)` re-read and reloaded. That sequence failed
 * this file's first case (the journal quotes the failure): the edit's autosave wrote `a.md`
 * between the `read_doc` and the `rename_file`, which installed the bytes read before it.
 */
function rename(io: Ipc, p: Pane, oldPath: string, newPath: string, oldStem: string, newStem: string) {
  return p.sync.renamed(
    (text) => rewriteAssetUrls(text, oldStem, newStem),
    async () => {
      await io.renameFile(oldPath, newPath);
      p.path = newPath;
    },
  );
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("rename read-then-write (task 3.11 reproduction)", () => {
  // Each case holds one IPC of the rename, injects a late edit (an image paste's `save_image`
  // resolving after the barrier) and fires its autosave while the IPC is held.
  for (const name of ["read_doc", "rename_file", "write_doc"]) {
    it(`an edit autosaved while ${name} is held is in the bytes at the new path and in the editor after the rename`, async () => {
      const io = ipc({ "a.md": "![x](assets/a/x.png)\n" });
      const p = pane(io, "a.md");
      const held = gate();
      io.holds.set(name, held);

      const done = rename(io, p, "a.md", "b.md", "a", "b");
      await vi.advanceTimersByTimeAsync(0);
      expect(io.calls.at(-1)).toMatch(new RegExp(`^${name} `));

      p.edit(`${p.editor.text}\nlate edit\n`);
      await vi.advanceTimersByTimeAsync(saveDelayMs);
      held.release();
      const outcome = await done;
      await vi.advanceTimersByTimeAsync(saveDelayMs * 4);

      // The checked outcome covers the edit: `saved` means the bytes at the new path hold it.
      expect(outcome).toEqual({ moved: true, result: "saved" });
      expect(io.files.has("a.md")).toBe(false);
      expect(io.files.get("b.md")).toContain("late edit");
      expect(io.files.get("b.md")).toContain("assets/b/x.png");
      expect(io.files.get("b.md")).not.toContain("assets/a/");
      expect(p.editor.text).toContain("late edit");
      expect(p.editor.text).toContain("assets/b/x.png");
      expect(p.sync.dirty).toBe(false);
      // Nothing was written under the old name after the move.
      const moved = io.calls.findIndex((c) => c.startsWith("rename_file "));
      expect(io.calls.slice(moved).filter((c) => c === "write_doc a.md")).toEqual([]);
    });
  }
});
