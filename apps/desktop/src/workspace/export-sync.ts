/**
 * `export`'s own IPC glue (task 4.3), as pure functions over injected I/O — the same split
 * `document-sync.ts` and `settings-sync.ts` use, so every rule here is a vitest case
 * (`tests/export-sync.test.ts`) rather than a WebdriverIO timing.
 *
 * `flush` settles the pending source burst before `readDoc` reads it (CLAUDE.md: a reader of the
 * document store that is not an editing surface settles the burst first) — the same rule
 * `App.tsx`'s `commitRename` already follows for its open-pane branch, and the same checked
 * outcome `flush` itself returns there (DECISIONS #review-2-r0 U1): `"conflict"` and `"failed"`
 * never reach `readDoc`/`runExport`/`reveal`, and are reported as `"not-saved"` instead of resolving
 * alike with a real export.
 *
 * `title` (DECISIONS #review-4-r0 U1) is decided here, from the just-settled bytes `readDoc`
 * returns, never from a stale copy: the document's own front-matter `title` always wins when
 * present (pandoc's `-M title=` would otherwise override it), so a title is sent only when
 * `readFrontMatter` finds none — the file's own stem, the same rule `outputPathFor` uses.
 */

import { parse, readFrontMatter } from "@essaydown/core";
import { stemOf } from "./paths";

export type ExportFlushResult = "clean" | "saved" | "conflict" | "failed";

export interface ExportOutcome {
  readonly outPath: string;
  readonly warning: string | null;
}

export interface ExportArgs {
  readonly path: string;
  readonly outPath: string;
  readonly format: string;
  readonly contents: string;
  /** Absent exactly when the document's own front matter already has a `title` (DECISIONS
   * #review-4-r0 U1); present as the document's own file stem otherwise. */
  readonly title?: string;
}

export interface ExportIO {
  flush(): Promise<ExportFlushResult>;
  readDoc(path: string): Promise<string>;
  runExport(args: ExportArgs): Promise<ExportOutcome>;
  reveal(path: string): Promise<void>;
}

export type ExportResult =
  | { readonly status: "not-saved"; readonly flush: "conflict" | "failed" }
  | { readonly status: "exported"; readonly outcome: ExportOutcome };

/** The whole File → Export flow (task 4.3's description), independent of the dialog that drives
 * it: flush, read the just-settled bytes, spawn the sidecar, and reveal the output in the OS file
 * manager on success — whether or not pandoc warned about a missing image (lesson [4.0]: that
 * warning is carried on `outcome.warning`, never thrown, so it reaches here as a success). */
export async function exportDocument(
  io: ExportIO,
  docPath: string,
  outPath: string,
  format: string,
): Promise<ExportResult> {
  const flush = await io.flush();
  if (flush === "conflict" || flush === "failed") return { status: "not-saved", flush };
  const contents = await io.readDoc(docPath);
  const hasOwnTitle = readFrontMatter(parse(contents)).title !== null;
  const title = hasOwnTitle ? undefined : stemOf(docPath);
  const outcome = await io.runExport({ path: docPath, outPath, format, contents, title });
  // Best-effort OS integration (there is no cross-desktop-environment reveal on Linux, `export.rs`'s
  // own comment): a reveal failure (no `xdg-open`, no file manager) is not an export failure — the
  // file pandoc wrote is not undone by it, so it never turns a successful export into a thrown one.
  try {
    await io.reveal(outcome.outPath);
  } catch {
    // intentionally ignored
  }
  return { status: "exported", outcome };
}
