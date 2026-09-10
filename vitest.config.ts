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
      // Deliberately excludes apps/desktop/src/** (the dev routes): that surface is covered by
      // the e2e/web Playwright specs, not this vitest run, so its coverage reads as unmeasured
      // here rather than as zero against a threshold (DECISIONS #review-1-r1 G7). The include
      // itself widens at Phase 2 planning (docs/V1.1-BACKLOG.md, hard stop 2.verify).
      include: ["packages/*/src/**/*.{ts,tsx}"],
      thresholds: {
        perFile: true,
        // Task 0.16: set just below the worst per-file measurement at the time of writing
        // (`pnpm coverage`: sentences.ts 97.76%/94.44% stmts/branches, sidecar.ts 99.4% lines),
        // so every file in the glob below is held to it, not just the ones a task happened to
        // reach 100% on.
        statements: 97,
        branches: 94,
        functions: 100,
        lines: 99,
        // Task 0.7 acceptance: the block/section algebra is fully branch-covered. Glob-keyed
        // thresholds replace the global ones for the files they match, so the other three
        // metrics are pinned at 100 here too rather than falling back to the global values.
        "packages/core/src/blocks.ts": {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
      },
    },
  },
});
