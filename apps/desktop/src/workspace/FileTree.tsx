import { useEffect, useRef, useState } from "react";
import type { TreeNode } from "./tree";

export type FileTreeProps = {
  nodes: TreeNode[];
  openPath: string | null;
  selectedPath: string | null;
  renamingPath: string | null;
  tooltipPath: string | null;
  onSelect: (path: string) => void;
  onOpen: (path: string) => void;
  onToggleTooltip: (path: string | null) => void;
  onContextMenu: (path: string, x: number, y: number) => void;
  onCommitRename: (path: string, newName: string) => void;
  onCancelRename: () => void;
  onStartRename: (path: string) => void;
};

/** "Not downloaded on this device" (task 2.4's description) shown by clicking a `cloudOnly` entry
 * (the acceptance's own trigger — a real `title` attribute is also set for hover, but a headless
 * WebdriverIO session cannot reliably drive a hover-timed native tooltip, so the click-shown
 * `data-testid="cloud-tooltip"` element is the instrument the e2e spec reads). Clicking such an
 * entry never calls `read_doc`: the file on disk is the `.icloud` placeholder, not the document, so
 * opening it is not an operation that could partially succeed — it is simply not attempted. */
const CLOUD_TOOLTIP_TEXT = "Not downloaded on this device";

function RenameInput({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(initial);
  useEffect(() => {
    const element = input.current;
    if (element === null) return;
    element.focus();
    element.select();
  }, []);
  return (
    <input
      ref={input}
      className="file-tree-rename-input"
      data-testid="rename-input"
      value={value}
      onChange={(event) => setValue(event.currentTarget.value)}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === "Enter") onCommit(value);
        else if (event.key === "Escape") onCancel();
      }}
      onBlur={() => onCommit(value)}
    />
  );
}

function FileRow({
  node,
  depth,
  props,
}: {
  node: TreeNode & { kind: "file" };
  depth: number;
  props: FileTreeProps;
}) {
  const isOpen = props.openPath === node.path;
  const isSelected = props.selectedPath === node.path;
  const isRenaming = props.renamingPath === node.path;
  const isTooltipShown = props.tooltipPath === node.path;

  return (
    <li
      className={`file-tree-row${isOpen ? " file-tree-row-open" : ""}${isSelected ? " file-tree-row-selected" : ""}${
        node.cloudOnly ? " file-tree-row-cloud-only" : ""
      }`}
      style={{ paddingLeft: `${depth * 14}px` }}
      data-testid={`tree-entry:${node.path}`}
      data-cloud-only={node.cloudOnly}
      title={node.cloudOnly ? CLOUD_TOOLTIP_TEXT : undefined}
      tabIndex={0}
      onClick={() => {
        props.onSelect(node.path);
        if (node.cloudOnly) props.onToggleTooltip(node.path);
        else {
          props.onToggleTooltip(null);
          props.onOpen(node.path);
        }
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        props.onSelect(node.path);
        props.onContextMenu(node.path, event.clientX, event.clientY);
      }}
      onKeyDown={(event) => {
        if (event.key === "F2" && !node.cloudOnly) {
          event.preventDefault();
          props.onStartRename(node.path);
        }
      }}
    >
      {isRenaming ? (
        <RenameInput
          initial={node.name}
          onCommit={(value) => props.onCommitRename(node.path, value)}
          onCancel={props.onCancelRename}
        />
      ) : (
        <span className="file-tree-row-name">{node.name}</span>
      )}
      {isTooltipShown && (
        <span className="file-tree-cloud-tooltip" data-testid="cloud-tooltip">
          {CLOUD_TOOLTIP_TEXT}
        </span>
      )}
    </li>
  );
}

function DirRow({ node, depth, props }: { node: TreeNode & { kind: "dir" }; depth: number; props: FileTreeProps }) {
  return (
    <li className="file-tree-row file-tree-row-dir" style={{ paddingLeft: `${depth * 14}px` }}>
      <span className="file-tree-row-name">{node.name}</span>
      <FileTreeLevel nodes={node.children} depth={depth + 1} props={props} />
    </li>
  );
}

function FileTreeLevel({ nodes, depth, props }: { nodes: TreeNode[]; depth: number; props: FileTreeProps }) {
  return (
    <ul className="file-tree-level">
      {nodes.map((node) =>
        node.kind === "dir" ? (
          <DirRow key={node.path} node={node} depth={depth} props={props} />
        ) : (
          <FileRow key={node.path} node={node} depth={depth} props={props} />
        ),
      )}
    </ul>
  );
}

/** The file tree sidebar's list (task 2.4): open folder / new file live in `App.tsx`'s toolbar
 * above this; this component is only the tree itself — click to open, F2 or a context menu to
 * rename, a context menu to delete or reveal, `cloudOnly` entries greyed with a click-shown
 * tooltip. */
export default function FileTree(props: FileTreeProps) {
  return (
    <div className="file-tree" data-testid="file-tree">
      <FileTreeLevel nodes={props.nodes} depth={0} props={props} />
    </div>
  );
}
