// check-deps.test.ts — DECISIONS #review-1-r0 F8: the PRD §4 "declare every dependency" rule now has
// an enforcement point (scripts/check-deps.mjs, wired into the root `lint` script). This file proves
// three things: the real tree passes today; the script's failure modes each name what is wrong; and
// docs/dependencies.json's own citations are truthful (the row/id each entry names actually exists).
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { cargoDependencies, checkAllowlist, npmDependencies } from "../scripts/check-deps.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = join(root, "scripts/check-deps.mjs");

function runCli(dir: string) {
  return spawnSync(process.execPath, [scriptPath, "--root", dir], { encoding: "utf8" });
}

describe("check-deps: the real tree", () => {
  it("passes docs/dependencies.json today (pnpm lint's own bar)", () => {
    expect(checkAllowlist(root)).toEqual([]);
  });

  it("the root lint script runs it, so every task's bar and every CI leg sees it", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    expect(pkg.scripts.lint).toContain("node scripts/check-deps.mjs");
  });
});

describe("check-deps: every allowlist entry names a real anchor", () => {
  const prd = readFileSync(join(root, "docs/PRD.md"), "utf8");
  const decisions = readFileSync(join(root, "docs/DECISIONS.md"), "utf8");
  const allowlist = JSON.parse(readFileSync(join(root, "docs/dependencies.json"), "utf8"));
  const entries = [
    ...Object.entries(allowlist.npm ?? {}),
    ...Object.entries(allowlist.cargo ?? {}),
  ];

  it.each(entries)(
    '%s: "%s" resolves to an existing PRD §4 row or DECISIONS id',
    (_name, citation) => {
      const asString = citation as string;
      const prdRow = /^PRD §4 (.+) row$/.exec(asString);
      const decisionsId = /^DECISIONS #(\S+)/.exec(asString);
      expect(
        prdRow || decisionsId,
        `citation "${asString}" is neither a "PRD §4 <row> row" nor a "DECISIONS #<id>" sentence`,
      ).toBeTruthy();
      if (prdRow) {
        const label = prdRow[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        expect(
          new RegExp(`^\\| ${label} \\|`, "m").test(prd),
          `no PRD §4 row labelled "${prdRow[1]}"`,
        ).toBe(true);
      }
      if (decisionsId) {
        const id = decisionsId[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        expect(
          new RegExp(`^## #${id}(\\b|-)`, "m").test(decisions),
          `no DECISIONS heading for #${decisionsId[1]}`,
        ).toBe(true);
      }
    },
  );
});

describe("check-deps: failure modes (temp-dir copies of the real workspace)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
  });

  /** A scratch copy of just enough of the workspace for the collectors to walk: root manifest +
   * pnpm-workspace.yaml, the Cargo workspace, one npm workspace package, and the real allowlist. */
  function scratch() {
    const dir = mkdtempSync(join(tmpdir(), "check-deps-"));
    dirs.push(dir);
    cpSync(join(root, "pnpm-workspace.yaml"), join(dir, "pnpm-workspace.yaml"));
    cpSync(join(root, "package.json"), join(dir, "package.json"));
    cpSync(join(root, "Cargo.toml"), join(dir, "Cargo.toml"));
    mkdirSync(join(dir, "docs"), { recursive: true });
    cpSync(join(root, "docs/dependencies.json"), join(dir, "docs/dependencies.json"));
    mkdirSync(join(dir, "apps/desktop/src-tauri"), { recursive: true });
    cpSync(
      join(root, "apps/desktop/src-tauri/Cargo.toml"),
      join(dir, "apps/desktop/src-tauri/Cargo.toml"),
    );
    mkdirSync(join(dir, "packages/core"), { recursive: true });
    cpSync(join(root, "packages/core/package.json"), join(dir, "packages/core/package.json"));
    return dir;
  }

  it("an undeclared npm package fails, naming the package and its manifest", () => {
    const dir = scratch();
    const pkgPath = join(dir, "packages/core/package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    pkg.dependencies["totally-fake-package"] = "^1.0.0";
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
    const r = runCli(dir);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("totally-fake-package");
    expect(r.stderr).toContain(join("packages", "core", "package.json"));
  });

  it("an undeclared cargo dependency fails, naming the package and its manifest", () => {
    const dir = scratch();
    const cargoPath = join(dir, "apps/desktop/src-tauri/Cargo.toml");
    writeFileSync(cargoPath, readFileSync(cargoPath, "utf8") + 'totally-fake-crate = "1"\n');
    const r = runCli(dir);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("totally-fake-crate");
    expect(r.stderr).toContain(join("apps", "desktop", "src-tauri", "Cargo.toml"));
  });

  it("a stale allowlist entry fails, naming it", () => {
    const dir = scratch();
    const depsPath = join(dir, "docs/dependencies.json");
    const deps = JSON.parse(readFileSync(depsPath, "utf8"));
    deps.npm["totally-stale-package"] = "PRD §4 Frontend row";
    writeFileSync(depsPath, JSON.stringify(deps));
    const r = runCli(dir);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("totally-stale-package");
  });

  it("a workspace:* entry is ignored (an internal package never needs an allowlist entry)", () => {
    const dir = scratch();
    const pkgPath = join(dir, "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    pkg.dependencies = { "@essaydown/nonexistent-internal": "workspace:*" };
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
    // Checked against the collector directly, not the CLI: this scratch tree's manifests are a
    // subset of the real workspace, so docs/dependencies.json's untouched entries for packages this
    // scratch doesn't copy would otherwise fail as "stale" for a reason unrelated to workspace:*.
    const names = npmDependencies(dir).map((d) => d.name);
    expect(names).not.toContain("@essaydown/nonexistent-internal");
  });

  it("the real tree's collectors agree with the CLI's own summary counts", () => {
    const r = runCli(root);
    expect(r.status).toBe(0);
    const npmCount = npmDependencies(root).length;
    const cargoCount = cargoDependencies(root).length;
    expect(r.stdout).toContain(`${npmCount} npm + ${cargoCount} cargo`);
  });
});
