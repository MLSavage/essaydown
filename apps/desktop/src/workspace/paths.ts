/**
 * Pure workspace-relative path helpers, mirroring the Rust derivations in
 * `apps/desktop/src-tauri/src/workspace.rs` (`sidecar_relative_for`, `assets_relative_for`) so the
 * sidebar can name a document's sidecar and assets directory for its rename/delete UI without a
 * round trip. Every path here is workspace-relative with `/` separators (`TreeEntry.path`'s own
 * shape); there is no OS-specific handling because these strings never touch the filesystem.
 */

export function dirnameOf(relative: string): string {
  const idx = relative.lastIndexOf("/");
  return idx === -1 ? "" : relative.slice(0, idx);
}

export function basenameOf(relative: string): string {
  const idx = relative.lastIndexOf("/");
  return idx === -1 ? relative : relative.slice(idx + 1);
}

/** The filename without its last extension, matching `Path::file_stem` for the plain `<name>.md`
 * shape every entry here has (list_tree only ever reports `.md` files). */
export function stemOf(relative: string): string {
  const base = basenameOf(relative);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? base : base.slice(0, dot);
}

export function joinRelative(dir: string, name: string): string {
  return dir === "" ? name : `${dir}/${name}`;
}

/** `<stem>.essaydown.json` beside the document (PRD §6 Identifiers). */
export function sidecarPathFor(relative: string): string {
  return joinRelative(dirnameOf(relative), `${stemOf(relative)}.essaydown.json`);
}

/** `assets/<stem>` beside the document (PRD §6.4). */
export function assetsPathFor(relative: string): string {
  return joinRelative(dirnameOf(relative), `assets/${stemOf(relative)}`);
}
