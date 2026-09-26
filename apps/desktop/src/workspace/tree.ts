import { basenameOf, dirnameOf } from "./paths";

/** The shape `list_tree` returns (camelCase: `#[serde(rename_all = "camelCase")]` on the Rust
 * `TreeEntry`). */
export type TreeEntry = { path: string; cloudOnly: boolean };

export type TreeNode =
  | { kind: "file"; path: string; name: string; cloudOnly: boolean }
  | { kind: "dir"; path: string; name: string; children: TreeNode[] };

/**
 * `list_tree` reports only `.md` files, flat, workspace-relative (task 2.2); this rebuilds the
 * directory hierarchy those paths imply, one node per directory component actually present in some
 * file's path — never an empty directory `list_tree` did not report. Each level sorts directories
 * before files, then by name, so the sidebar reads as a conventional file tree (Michael's ask,
 * DECISIONS #002-outline-feel: "like Typora and VS Code").
 */
export function buildTree(entries: readonly TreeEntry[]): TreeNode[] {
  const root: TreeNode[] = [];
  const dirs = new Map<string, TreeNode & { kind: "dir" }>();

  function ensureDir(path: string): TreeNode[] {
    if (path === "") return root;
    const existing = dirs.get(path);
    if (existing !== undefined) return existing.children;
    const parent = ensureDir(dirnameOf(path));
    const node: TreeNode & { kind: "dir" } = { kind: "dir", path, name: basenameOf(path), children: [] };
    dirs.set(path, node);
    parent.push(node);
    return node.children;
  }

  for (const entry of entries) {
    const siblings = ensureDir(dirnameOf(entry.path));
    siblings.push({ kind: "file", path: entry.path, name: basenameOf(entry.path), cloudOnly: entry.cloudOnly });
  }

  function sortLevel(nodes: TreeNode[]): void {
    nodes.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1));
    for (const node of nodes) if (node.kind === "dir") sortLevel(node.children);
  }
  sortLevel(root);
  return root;
}
