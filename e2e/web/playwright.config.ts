import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";

// The repo root: `pnpm --filter` has to run from the workspace, not from this package.
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const port = 1420;

export default defineConfig({
  // `.` rather than `./tests` because task 1.3's acceptance names `e2e/web/editor-input.spec.ts`;
  // the placeholder spec of task 0.1 still lives in `tests/` and is still collected.
  testDir: ".",
  testIgnore: ["**/node_modules/**"],
  use: { baseURL: `http://localhost:${port}` },
  webServer: {
    // The dev routes of PRD §8 are pure web (no Tauri call), so plain Vite serves them.
    command: "pnpm --filter @essaydown/desktop dev",
    cwd: repoRoot,
    url: `http://localhost:${port}/dev/editor`,
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
