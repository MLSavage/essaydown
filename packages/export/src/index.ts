/**
 * Pandoc argument builders (PRD §4 `packages/export` row: "spawning is in src-tauri"). Pure
 * functions only — no DOM, no module-level config, no process spawning here; `apps/desktop/src-
 * tauri/src/export.rs` mirrors this exact argument shape in Rust, since the two cannot share code
 * across the language boundary.
 */

/** Pandoc writer names this package accepts: one lowercase letter, then lowercase letters/digits/
 * underscore — the same shape `capabilities/default.json`'s `-t` validator accepts (task 4.2). */
const FORMAT_PATTERN = /^[a-z][a-z0-9_]*$/;

export function isValidPandocFormat(format: string): boolean {
  return FORMAT_PATTERN.test(format);
}

export interface PandocExportTarget {
  /** Workspace-relative directory pandoc resolves the document's relative image references
   * against ("." when the document lives at the workspace root). */
  readonly resourceDir: string;
  /** Workspace-relative output file path. */
  readonly outPath: string;
  /** Pandoc `-t` writer name, e.g. "docx" or "html". */
  readonly format: string;
  /** The title to feed pandoc as `--metadata title=<title>`, when the document has no front-matter
   * `title` of its own — absent (never `""`) when it does, so that title always wins (DECISIONS
   * #review-4-r0 U1; `-M title=` overrides a yaml `title`, confirmed in the pinned pandoc 3.11). */
  readonly title?: string;
}

/**
 * The fixed 9-token pandoc invocation (task 4.3's description; DECISIONS #004's primary pipeline):
 * `-f gfm --standalone --resource-path=<dir> -o <out> --pdf-engine=typst -t <format>`, with two more
 * tokens, `--metadata title=<title>`, appended when `target.title` is given (DECISIONS #review-4-r0
 * U1) — every export otherwise carries no title at all, so a document with no front-matter `title`
 * produced an EPUB with no `dc:title` and an empty nav anchor (epubcheck RSC-005). The source
 * document is never a positional argument — production code feeds it over stdin (no input file to
 * resolve a workspace path for), so this array has no such entry.
 */
export function buildPandocArgs(target: PandocExportTarget): string[] {
  if (!isValidPandocFormat(target.format)) {
    throw new RangeError(`not a valid pandoc format: ${target.format}`);
  }
  const args = [
    "-f",
    "gfm",
    "--standalone",
    `--resource-path=${target.resourceDir}`,
    "-o",
    target.outPath,
    "--pdf-engine=typst",
    "-t",
    target.format,
  ];
  return target.title === undefined ? args : [...args, "--metadata", `title=${target.title}`];
}

/** One pandoc writer name per format this app's export dialog offers by default; any other format
 * string is "Other" and is used verbatim as the output file's extension too. */
const DEFAULT_EXTENSIONS: Readonly<Record<string, string>> = {
  docx: "docx",
  html: "html",
};

function splitPath(path: string): { dir: string; base: string } {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? { dir: "", base: path } : { dir: path.slice(0, slash + 1), base: path.slice(slash + 1) };
}

/** The workspace-relative directory containing `docPath`'s document, in pandoc's own `--resource-
 * path` spelling: "." when the document is at the workspace root. */
export function resourceDirFor(docPath: string): string {
  const { dir } = splitPath(docPath);
  return dir === "" ? "." : dir.slice(0, -1);
}

/** `docPath`'s own directory and stem, with `format`'s extension (or `format` itself, for "Other"
 * formats this package does not special-case) — the default export output path a caller offers the
 * user before letting them override it. */
export function outputPathFor(docPath: string, format: string): string {
  const { dir, base } = splitPath(docPath);
  const dot = base.lastIndexOf(".");
  const stem = dot <= 0 ? base : base.slice(0, dot);
  const extension = DEFAULT_EXTENSIONS[format] ?? format;
  return `${dir}${stem}.${extension}`;
}

/**
 * Pandoc exits 0 even when `--resource-path` cannot resolve a referenced image, replacing it with
 * its alt text and writing one `[WARNING] Could not fetch resource …` line to stderr per missing
 * image (lesson [4.0]) — so a missing image is a warning, never a failure, and is read from stderr
 * text rather than the exit code. `apps/desktop/src-tauri/src/export.rs`'s `classify` makes the
 * same check in Rust, since this function runs only in the test/frontend and cannot be called from
 * Rust directly.
 */
export function isMissingResourceWarning(stderr: string): boolean {
  return stderr.includes("Could not fetch resource");
}
