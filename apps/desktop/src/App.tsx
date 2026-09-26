import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import "./App.css";
import ConfirmDelete from "./workspace/ConfirmDelete";
import ContextMenu, { type ContextMenuTarget } from "./workspace/ContextMenu";
import FileTree from "./workspace/FileTree";
import { basenameOf, dirnameOf, joinRelative } from "./workspace/paths";
import { readLastWorkspace, writeLastWorkspace } from "./workspace/storage";
import { buildTree, type TreeEntry } from "./workspace/tree";

function describeError(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * The real `/` page (task 2.4; DECISIONS #review-1-r0 F11 names this as the first Phase 2 task to
 * replace the Vite scaffold). A left file tree sidebar over the IPC surface tasks 2.2/2.3 built
 * (`open_folder`, `list_tree`, `read_doc`, `new_file`, `rename_file`, `delete_to_trash`,
 * `reveal_in_folder`), and a minimal main pane that shows the currently open document's raw text —
 * wiring the real rendered/source editor onto this page is later Phase 2 work (autosave, 2.5),
 * not this task's scope.
 *
 * "Last folder and file restored on launch" (the description's own words) is `localStorage`
 * (`./workspace/storage.ts`): the IPC surface has no persistence command for it and does not need
 * one, since `open_folder` + `list_tree` + `read_doc` are already enough to replay a restore.
 */
function App() {
  const [root, setRoot] = useState<string | null>(null);
  const [entries, setEntries] = useState<readonly TreeEntry[]>([]);
  const [openPath, setOpenPath] = useState<string | null>(null);
  const [openContent, setOpenContent] = useState("");
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [tooltipPath, setTooltipPath] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuTarget | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // `openFolderDialog` (the "Open Folder" button) and the launch-restore effect both open a folder
  // this same way; the restore effect also opens the last file afterwards, which this alone does
  // not do.
  const setWorkspace = useCallback(async (path: string): Promise<string | null> => {
    try {
      const canonical = await invoke<string>("open_folder", { path });
      setRoot(canonical);
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
        const contents = await invoke<string>("read_doc", { path });
        setOpenPath(path);
        setOpenContent(contents);
        setError(null);
        if (root !== null) writeLastWorkspace({ folder: root, file: path });
      } catch (readError) {
        setError(describeError(readError));
      }
    },
    [root],
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
        const tree = await invoke<TreeEntry[]>("list_tree");
        if (cancelled) return;
        setEntries(tree);
        const openable = last.file !== null && tree.some((e) => e.path === last.file && !e.cloudOnly);
        if (openable && last.file !== null) {
          const contents = await invoke<string>("read_doc", { path: last.file });
          if (cancelled) return;
          setOpenPath(last.file);
          setOpenContent(contents);
        }
      } catch (restoreError) {
        if (!cancelled) setError(describeError(restoreError));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const refreshTree = useCallback(async (): Promise<TreeEntry[]> => {
    const tree = await invoke<TreeEntry[]>("list_tree");
    setEntries(tree);
    return tree;
  }, []);

  const openFolderDialog = useCallback(async (): Promise<void> => {
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected !== "string") return; // the user cancelled the native dialog
    const canonical = await setWorkspace(selected);
    if (canonical === null) return;
    writeLastWorkspace({ folder: canonical, file: null });
    setOpenPath(null);
    setOpenContent("");
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
        await invoke("rename_file", { oldPath, newPath });
        await refreshTree();
        setError(null);
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
          setOpenContent("");
          if (root !== null) writeLastWorkspace({ folder: root, file: null });
        }
      } catch (deleteError) {
        setError(describeError(deleteError));
      }
    },
    [openPath, refreshTree, root],
  );

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
        {openPath === null ? (
          <p className="workspace-empty" data-testid="workspace-empty">
            No file open
          </p>
        ) : (
          <>
            <div className="workspace-current-file" data-testid="current-file">
              {openPath}
            </div>
            <pre className="workspace-content" data-testid="current-content">
              {openContent}
            </pre>
          </>
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
      {error !== null && (
        <div className="workspace-error" data-testid="error">
          {error}
        </div>
      )}
    </div>
  );
}

export default App;
