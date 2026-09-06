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
      include: ["packages/*/src/**/*.{ts,tsx}"],
      thresholds: {
        perFile: true,
        statements: 0,
        branches: 0,
        functions: 0,
        lines: 0,
        // Task 0.7 acceptance: the block/section algebra is fully branch-covered. Glob-keyed
        // thresholds replace the global ones for the files they match, so the other three
        // metrics are pinned at 100 here too rather than falling back to 0.
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
