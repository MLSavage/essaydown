import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    reporters: ["default"],
    include: [
      "packages/*/test/**/*.test.ts",
      "packages/*/test/**/*.test.tsx",
      "tests/**/*.test.ts",
    ],
    coverage: {
      provider: "v8",
      reporter: [["text", { skipFull: false }], "html"],
      // packages/*/src/** is the pure-TS core and editor, exercised entirely by this vitest run;
      // apps/desktop/src/** is the Tauri shell, exercised partly here (tests/*.test.ts against its
      // exported helpers) and partly only by the e2e/shell and e2e/web suites (the panels' DOM
      // wiring, drag/drop, Tauri IPC call sites) — that remaining surface is measured at 0% below
      // rather than left unmeasured (DECISIONS #review-1-r1 G7, #review-2-r0 U10, #review-3-r0 C12).
      include: [
        "packages/*/src/**/*.{ts,tsx}",
        "apps/desktop/src/**/*.{ts,tsx}",
      ],
      thresholds: {
        perFile: true,
        // The bare statements/branches/functions/lines keys here would be the GLOBAL fallback,
        // checked per file against every file this run measures (vitest's resolveThresholds
        // always builds that global group from the whole coverage map, in addition to each named
        // glob below) — so packages/*'s own numbers live in their own glob key instead, task 4.10,
        // to stop them being asked of apps/desktop/src's files too.
        //
        // Task 0.16: set just below the worst per-file measurement at the time of writing
        // (`pnpm coverage`: sentences.ts 97.76%/94.44% stmts/branches, sidecar.ts 99.4% lines),
        // so every file in the glob below is held to it, not just the ones a task happened to
        // reach 100% on. Unchanged by task 4.10, only relocated out of the global fallback.
        "packages/*/src/**/*.{ts,tsx}": {
          perFile: true,
          statements: 97,
          branches: 94,
          functions: 100,
          lines: 99,
        },
        // Task 0.7 acceptance: the block/section algebra is fully branch-covered. Glob-keyed
        // thresholds replace the global ones for the files they match, so the other three
        // metrics are pinned at 100 here too rather than falling back to the global values.
        "packages/core/src/blocks.ts": {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
        // Task 4.10: apps/desktop/src is a shell that this run only partly reaches (the rest is
        // e2e/shell and e2e/web ground), so each file below is held to its own measurement in
        // this container, not to the packages/* numbers above — one glob-keyed entry per file,
        // each set at or just below its own stmts/branches/funcs/lines at the time of writing
        // (`pnpm coverage`). A 0 recorded here is a file this suite does not reach at all.
        "apps/desktop/src/App.tsx": {
          statements: 0,
          branches: 0,
          functions: 0,
          lines: 0,
        },
        "apps/desktop/src/main.tsx": {
          statements: 0,
          branches: 0,
          functions: 100,
          lines: 0,
        },
        "apps/desktop/src/vite-env.d.ts": {
          statements: 0,
          branches: 0,
          functions: 0,
          lines: 0,
        },
        "apps/desktop/src/dev/DevEditor.tsx": {
          statements: 0,
          branches: 0,
          functions: 0,
          lines: 0,
        },
        "apps/desktop/src/dev/DevOutline.tsx": {
          statements: 0,
          branches: 0,
          functions: 0,
          lines: 0,
        },
        "apps/desktop/src/dev/DevSource.tsx": {
          statements: 0,
          branches: 0,
          functions: 0,
          lines: 0,
        },
        "apps/desktop/src/dev/outline-document.ts": {
          statements: 0,
          branches: 0,
          functions: 0,
          lines: 0,
        },
        "apps/desktop/src/dev/outline-handoff.ts": {
          statements: 0,
          branches: 0,
          functions: 0,
          lines: 0,
        },
        "apps/desktop/src/dev/outline-hints.ts": {
          statements: 0,
          branches: 0,
          functions: 0,
          lines: 0,
        },
        "apps/desktop/src/modes/ModeBar.tsx": {
          statements: 0,
          branches: 0,
          functions: 0,
          lines: 0,
        },
        "apps/desktop/src/modes/modes.ts": {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
        "apps/desktop/src/modes/undo-keys.ts": {
          statements: 0,
          branches: 0,
          functions: 0,
          lines: 0,
        },
        "apps/desktop/src/outline/OutlinePanel.tsx": {
          statements: 0,
          branches: 0,
          functions: 0,
          lines: 0,
        },
        "apps/desktop/src/outline/OutlineTree.tsx": {
          statements: 0,
          branches: 0,
          functions: 0,
          lines: 0,
        },
        "apps/desktop/src/outline/QuestionField.tsx": {
          statements: 0,
          branches: 0,
          functions: 0,
          lines: 0,
        },
        "apps/desktop/src/outline/outline-view.ts": {
          statements: 0,
          branches: 0,
          functions: 0,
          lines: 0,
        },
        "apps/desktop/src/reorder/ReorderPanel.tsx": {
          statements: 0,
          branches: 0,
          functions: 0,
          lines: 0,
        },
        "apps/desktop/src/rewrite/RewritePanel.tsx": {
          statements: 0,
          branches: 0,
          functions: 0,
          lines: 0,
        },
        "apps/desktop/src/settings/SettingsDialog.tsx": {
          statements: 0,
          branches: 0,
          functions: 0,
          lines: 0,
        },
        "apps/desktop/src/settings/settings-sync.ts": {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
        "apps/desktop/src/workspace/ConfirmDelete.tsx": {
          statements: 0,
          branches: 100,
          functions: 0,
          lines: 0,
        },
        "apps/desktop/src/workspace/ContextMenu.tsx": {
          statements: 0,
          branches: 0,
          functions: 0,
          lines: 0,
        },
        "apps/desktop/src/workspace/DocumentPane.tsx": {
          statements: 22,
          branches: 12,
          functions: 27,
          lines: 23,
        },
        "apps/desktop/src/workspace/FileTree.tsx": {
          statements: 0,
          branches: 0,
          functions: 0,
          lines: 0,
        },
        "apps/desktop/src/workspace/close-guard.ts": {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
        "apps/desktop/src/workspace/document-sync.ts": {
          statements: 97,
          branches: 90,
          functions: 100,
          lines: 100,
        },
        "apps/desktop/src/workspace/image-paste.ts": {
          statements: 3,
          branches: 0,
          functions: 0,
          lines: 3,
        },
        "apps/desktop/src/workspace/image-view.ts": {
          statements: 0,
          branches: 0,
          functions: 0,
          lines: 0,
        },
        "apps/desktop/src/workspace/paths.ts": {
          statements: 95,
          branches: 88,
          functions: 87,
          lines: 95,
        },
        "apps/desktop/src/workspace/sidecar-sync.ts": {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
        "apps/desktop/src/workspace/storage.ts": {
          statements: 0,
          branches: 0,
          functions: 0,
          lines: 0,
        },
        "apps/desktop/src/workspace/test-hook.ts": {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
        "apps/desktop/src/workspace/tree.ts": {
          statements: 0,
          branches: 0,
          functions: 0,
          lines: 0,
        },
      },
    },
  },
});
