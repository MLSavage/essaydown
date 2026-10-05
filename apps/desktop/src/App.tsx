import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { rewriteAssetUrls } from "@essaydown/core";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import "./App.css";
import SettingsDialog from "./settings/SettingsDialog";
import type { HasCoachKeyResult, SettingsIO } from "./settings/settings-sync";
import ConfirmDelete from "./workspace/ConfirmDelete";
import { decideClose } from "./workspace/close-guard";
import ContextMenu, { type ContextMenuTarget } from "./workspace/ContextMenu";
import DocumentPane, { loadDocument, type DocumentPaneHandle, type LoadedDocument } from "./workspace/DocumentPane";
import type { FlushResult } from "./workspace/document-sync";
import FileTree from "./workspace/FileTree";
import { basenameOf, dirnameOf, joinRelative, stemOf } from "./workspace/paths";
import { readLastWorkspace, writeLastWorkspace } from "./workspace/storage";
import { buildTree, type TreeEntry } from "./workspace/tree";

/**
 * The line a switch, an Open Folder… or a rename shows when the open document is not on disk: the
 * pane, its banner and its error stay, and nothing moves until the user resolves it
 * (DECISIONS #review-2-r0 U1).
 */
function switchWaits(result: FlushResult): string | null {
  if (result === "conflict") return "Not switched: choose Reload or Keep mine on 'Changed on disk' first.";
  if (result === "failed") return "Not switched: this document is not saved yet.";
  return null;
}

function describeError(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * The real `/` page (task 2.4; DECISIONS #review-1-r0 F11 names this as the first Phase 2 task to
 * replace the Vite scaffold). A left file tree sidebar over the IPC surface tasks 2.2/2.3 built
 * (`open_folder`, `list_tree`, `read_doc`, `new_file`, `rename_file`, `delete_to_trash`,
 * `reveal_in_folder`), and a main pane holding the open document. Since task 2.5 that pane is the
 * rendered editor with autosave and external-change handling (`./workspace/DocumentPane.tsx`), and
 * every folder the app opens is watched (`watch_folder`, `fs:changed`).
 *
 * "Last folder and file restored on launch" (the description's own words) is `localStorage`
 * (`./workspace/storage.ts`): the IPC surface has no persistence command for it and does not need
 * one, since `open_folder` + `list_tree` + `read_doc` are already enough to replay a restore.
 */
function App() {
  const [root, setRoot] = useState<string | null>(null);
  const [entries, setEntries] = useState<readonly TreeEntry[]>([]);
  const [openPath, setOpenPath] = useState<string | null>(null);
  // One value per open, numbered so the pane remounts on every open and never on a rename, which
  // changes `openPath` alone.
  const [openDoc, setOpenDoc] = useState<{ id: number; loaded: LoadedDocument } | null>(null);
  const opens = useRef(0);
  const showDocument = useCallback((path: string, loaded: LoadedDocument): void => {
    opens.current += 1;
    setOpenPath(path);
    setOpenDoc({ id: opens.current, loaded });
  }, []);
  const pane = useRef<DocumentPaneHandle>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [tooltipPath, setTooltipPath] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuTarget | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Beside `error`, never over it: a failed save's message stays while the switch waits.
  const [waiting, setWaiting] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const settingsIO: SettingsIO = useMemo(
    () => ({
      getSettings: () => invoke<string | null>("get_settings"),
      setSettings: (contents) => invoke("set_settings", { contents }),
      hasCoachKey: () => invoke<HasCoachKeyResult>("has_coach_key"),
      log: (message) => console.warn(message),
    }),
    [],
  );

  // The settings dialog's own trigger (task 2.7's description: Cmd/Ctrl+,), global so it opens
  // regardless of which pane has focus.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if ((event.metaKey || event.ctrlKey) && event.key === ",") {
        event.preventDefault();
        setSettingsOpen(true);
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  // The close barrier (DECISIONS #review-2-r0 U2): a close request (the title bar, Alt+F4, Cmd+W)
  // waits for the pending save instead of dropping the keystrokes inside the autosave debounce.
  // `onCloseRequested` destroys the window after the handler unless it is prevented, and the Rust
  // side prevents the native close whenever this listener exists, so the handler always prevents
  // and destroys only once the disk holds the editor's document (`core:window:allow-destroy`).
  useEffect(() => {
    const appWindow = getCurrentWindow();
    let unlisten: (() => void) | null = null;
    let disposed = false;
    void appWindow
      .onCloseRequested(async (event) => {
        event.preventDefault();
        try {
          const decision = decideClose((await pane.current?.flush()) ?? "clean");
          if (decision.action === "destroy") {
            await appWindow.destroy();
            return;
          }
          setWaiting(decision.waits);
        } catch (closeError) {
          setError(describeError(closeError));
        }
      })
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  // `openFolderDialog` (the "Open Folder" button) and the launch-restore effect both open a folder
  // this same way; the restore effect also opens the last file afterwards, which this alone does
  // not do.
  const setWorkspace = useCallback(async (path: string): Promise<string | null> => {
    try {
      const canonical = await invoke<string>("open_folder", { path });
      setRoot(canonical);
      await invoke("watch_folder", { path: "" });
      const tree = await invoke<TreeEntry[]>("list_tree");
      setEntries(tree);
      setError(null);
      return canonical;
    } catch (openError) {
      setError(describeError(openError));
      return null;
    }
  }, []);

  const openFile = useCallback(
    async (path: string): Promise<void> => {
      try {
        const waits = switchWaits((await pane.current?.flush()) ?? "clean");
        setWaiting(waits);
        if (waits !== null) return;
        showDocument(path, await loadDocument(path));
        setError(null);
        if (root !== null) writeLastWorkspace({ folder: root, file: path });
      } catch (readError) {
        setError(describeError(readError));
      }
    },
    [root, showDocument],
  );

  // Restore the last folder and file on launch (task 2.4's description). A StrictMode double
  // render re-runs this effect; both `open_folder` and `list_tree` are idempotent given the same
  // path, and `cancelled` keeps the first run's state updates from landing after the second run's.
  useEffect(() => {
    let cancelled = false;
    const last = readLastWorkspace();
    if (last === null) return;
    (async () => {
      try {
        const canonical = await invoke<string>("open_folder", { path: last.folder });
        if (cancelled) return;
        setRoot(canonical);
        await invoke("watch_folder", { path: "" });
        const tree = await invoke<TreeEntry[]>("list_tree");
        if (cancelled) return;
        setEntries(tree);
        const openable = last.file !== null && tree.some((e) => e.path === last.file && !e.cloudOnly);
        if (openable && last.file !== null) {
          const loaded = await loadDocument(last.file);
          if (cancelled) return;
          showDocument(last.file, loaded);
        }
      } catch (restoreError) {
        if (!cancelled) setError(describeError(restoreError));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [showDocument]);

  const refreshTree = useCallback(async (): Promise<TreeEntry[]> => {
    const tree = await invoke<TreeEntry[]>("list_tree");
    setEntries(tree);
    return tree;
  }, []);

  const openFolderDialog = useCallback(async (): Promise<void> => {
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected !== "string") return; // the user cancelled the native dialog
    const waits = switchWaits((await pane.current?.flush()) ?? "clean");
    setWaiting(waits);
    if (waits !== null) return;
    const canonical = await setWorkspace(selected);
    if (canonical === null) return;
    writeLastWorkspace({ folder: canonical, file: null });
    setOpenPath(null);
    setOpenDoc(null);
  }, [setWorkspace]);

  const createNewFile = useCallback(async (): Promise<void> => {
    try {
      const path = await invoke<string>("new_file");
      await refreshTree();
      await openFile(path);
    } catch (newFileError) {
      setError(describeError(newFileError));
    }
  }, [openFile, refreshTree]);

  const commitRename = useCallback(
    async (oldPath: string, newName: string): Promise<void> => {
      setRenamingPath(null);
      const trimmed = newName.trim();
      if (trimmed === "" || trimmed === basenameOf(oldPath)) return;
      const newPath = joinRelative(dirnameOf(oldPath), trimmed);
      try {
        const openPane = openPath === oldPath ? pane.current : null;
        if (openPane !== null) {
          // The open document saves, moves and has its image URLs rewritten inside its sync's chain,
          // so no autosave lands between a read of the old path and the write of its rewrite, nor
          // recreates the old name after the move (DECISIONS #review-2-r3, task 3.11).
          const outcome = await openPane.rename(newPath, () => invoke("rename_file", { oldPath, newPath }));
          setWaiting(outcome.moved ? null : switchWaits(outcome.result));
          if (!outcome.moved) return;
          // The pane reported a failed post-move write itself; it stays on screen.
          if (outcome.result !== "failed") setError(null);
        } else {
          // The rewritten bytes are computed before the first move, so a failed read changes nothing.
          const source = await invoke<string>("read_doc", { path: oldPath });
          const next = rewriteAssetUrls(source, stemOf(oldPath), stemOf(newPath));
          await invoke("rename_file", { oldPath, newPath, rewritten: next === source ? undefined : next });
          setError(null);
        }
        await refreshTree();
        if (openPath === oldPath) {
          setOpenPath(newPath);
          if (root !== null) writeLastWorkspace({ folder: root, file: newPath });
        }
        if (selectedPath === oldPath) setSelectedPath(newPath);
      } catch (renameError) {
        setError(describeError(renameError));
      }
    },
    [openPath, refreshTree, root, selectedPath],
  );

  const deleteEntry = useCallback(
    async (path: string): Promise<void> => {
      setDeleteTarget(null);
      try {
        await invoke("delete_to_trash", { path });
        await refreshTree();
        setError(null);
        if (openPath === path) {
          setOpenPath(null);
          setOpenDoc(null);
          if (root !== null) writeLastWorkspace({ folder: root, file: null });
        }
      } catch (deleteError) {
        setError(describeError(deleteError));
      }
    },
    [openPath, refreshTree, root],
  );

  // §6.1's Undo-open: close the non-canonical file without saving it, and forget it as the file to
  // restore on launch, so declining the rewrite never leads to one.
  const undoOpen = useCallback((): void => {
    setOpenPath(null);
    setOpenDoc(null);
    if (root !== null) writeLastWorkspace({ folder: root, file: null });
  }, [root]);

  const revealInFolder = useCallback(async (path: string): Promise<void> => {
    try {
      await invoke("reveal_in_folder", { path });
    } catch (revealError) {
      setError(describeError(revealError));
    }
  }, []);

  const nodes = buildTree(entries);
  const cloudOnlyByPath = new Map(entries.map((e) => [e.path, e.cloudOnly]));

  return (
    <div className="app-shell">
      <aside className="sidebar" data-testid="sidebar">
        <div className="sidebar-toolbar">
          <button
            type="button"
            data-testid="open-folder"
            onClick={() => {
              void openFolderDialog();
            }}
          >
            Open Folder…
          </button>
          <button
            type="button"
            data-testid="new-file"
            disabled={root === null}
            onClick={() => {
              void createNewFile();
            }}
          >
            New File
          </button>
        </div>
        {root === null ? (
          <p className="sidebar-empty" data-testid="sidebar-empty">
            No folder open
          </p>
        ) : (
          <FileTree
            nodes={nodes}
            openPath={openPath}
            selectedPath={selectedPath}
            renamingPath={renamingPath}
            tooltipPath={tooltipPath}
            onSelect={setSelectedPath}
            onOpen={(path) => {
              void openFile(path);
            }}
            onToggleTooltip={setTooltipPath}
            onContextMenu={(path, x, y) => setContextMenu({ path, cloudOnly: cloudOnlyByPath.get(path) ?? false, x, y })}
            onCommitRename={(path, name) => {
              void commitRename(path, name);
            }}
            onCancelRename={() => setRenamingPath(null)}
            onStartRename={setRenamingPath}
          />
        )}
      </aside>
      <main className="workspace-main" data-testid="main">
        {openPath === null || openDoc === null || root === null ? (
          <p className="workspace-empty" data-testid="workspace-empty">
            No file open
          </p>
        ) : (
          <DocumentPane
            key={openDoc.id}
            ref={pane}
            root={root}
            path={openPath}
            initial={openDoc.loaded}
            onUndoOpen={undoOpen}
            onError={setError}
          />
        )}
      </main>
      {contextMenu !== null && (
        <ContextMenu
          target={contextMenu}
          onRename={setRenamingPath}
          onDelete={setDeleteTarget}
          onReveal={(path) => {
            void revealInFolder(path);
          }}
          onClose={() => setContextMenu(null)}
        />
      )}
      {deleteTarget !== null && (
        <ConfirmDelete
          path={deleteTarget}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={(path) => {
            void deleteEntry(path);
          }}
        />
      )}
      {(error !== null || waiting !== null) && (
        <div className="workspace-error" data-testid="error">
          {error}
          {waiting !== null && <div data-testid="switch-waits">{waiting}</div>}
        </div>
      )}
      {settingsOpen && <SettingsDialog io={settingsIO} onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}

export default App;
