#!/usr/bin/env node
// check-deps.mjs — enforces PRD §4 "no new dependency without a declaration" at the existing lint bar,
// so it can no longer reach a review before anyone asked (DECISIONS #review-1-r0 F8). Plain Node, no deps.
//   node scripts/check-deps.mjs [--root <dir>]   check the workspace at <dir> (default: repo root)
// Reads every workspace package.json (pnpm-workspace.yaml's globs plus the root) and every Cargo.toml
// in the Cargo workspace, collects direct dependency names, and checks each against the committed
// allowlist docs/dependencies.json. Fails naming the package and its manifest when a direct dependency
// has no entry, and fails naming a stale entry when the allowlist names a package no manifest declares.
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Expand a pnpm-workspace.yaml `packages:` glob of the shape "dir/*" (the only shape this repo uses)
 * into the existing subdirectories of `root/dir`. Any other pattern is returned as a single literal path. */
function expandGlob(root, pattern) {
  if (!pattern.endsWith("/*")) return [pattern];
  const parent = pattern.slice(0, -2);
  const dir = join(root, parent);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => join(parent, e.name));
}

/** The `packages:` list of pnpm-workspace.yaml: a flat, unindented YAML list of bare or quoted strings. */
function readWorkspaceGlobs(root) {
  const lines = readFileSync(join(root, "pnpm-workspace.yaml"), "utf8").split("\n");
  const start = lines.findIndex((l) => /^packages:\s*$/.test(l));
  if (start < 0) throw new Error("pnpm-workspace.yaml has no packages: list");
  const globs = [];
  for (let i = start + 1; i < lines.length; i++) {
    const m = /^\s*-\s*["']?([^"'#]+?)["']?\s*$/.exec(lines[i]);
    if (!m) break;
    globs.push(m[1]);
  }
  return globs;
}

/** Every package.json in the workspace, relative to root: the root's own plus every directory the
 * pnpm-workspace.yaml globs resolve to that actually has one. */
export function workspaceManifests(root) {
  const dirs = ["."];
  for (const g of readWorkspaceGlobs(root)) dirs.push(...expandGlob(root, g));
  return dirs.map((d) => join(d, "package.json")).filter((p) => existsSync(join(root, p)));
}

const NPM_FIELDS = ["dependencies", "devDependencies", "optionalDependencies"];

/** [{name, manifest}] for every direct npm dependency across the workspace; workspace:* entries excluded. */
export function npmDependencies(root) {
  const out = [];
  for (const manifest of workspaceManifests(root)) {
    const pkg = JSON.parse(readFileSync(join(root, manifest), "utf8"));
    for (const field of NPM_FIELDS) {
      for (const [name, spec] of Object.entries(pkg[field] ?? {})) {
        if (typeof spec === "string" && spec.startsWith("workspace:")) continue;
        out.push({ name, manifest });
      }
    }
  }
  return out;
}

/** Every Cargo.toml in the Cargo workspace: the root plus every `[workspace].members` entry. */
export function cargoManifests(root) {
  const text = readFileSync(join(root, "Cargo.toml"), "utf8");
  const m = /members\s*=\s*\[([^\]]*)\]/.exec(text);
  const members = m
    ? m[1]
        .split(",")
        .map((s) => s.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean)
    : [];
  return ["Cargo.toml", ...members.map((mem) => join(mem, "Cargo.toml"))].filter((p) =>
    existsSync(join(root, p)),
  );
}

const CARGO_TABLES = ["dependencies", "dev-dependencies", "build-dependencies"];

/** [{name, manifest}] for every direct cargo dependency across the workspace. A minimal table-header +
 * key scan: sufficient for this repo's Cargo.toml shape (no [workspace.dependencies], no inline table
 * spanning lines); it does not need to parse values, only the key under one of CARGO_TABLES. */
export function cargoDependencies(root) {
  const out = [];
  for (const manifest of cargoManifests(root)) {
    const lines = readFileSync(join(root, manifest), "utf8").split("\n");
    let table = null;
    for (const line of lines) {
      const h = /^\s*\[([^\]]+)\]\s*$/.exec(line);
      if (h) {
        table = h[1].trim();
        continue;
      }
      if (!table || !CARGO_TABLES.includes(table)) continue;
      const kv = /^\s*([A-Za-z0-9_-]+)\s*=/.exec(line);
      if (kv) out.push({ name: kv[1], manifest });
    }
  }
  return out;
}

/** Check the workspace at `root` against docs/dependencies.json. Returns a list of error strings
 * (empty when every direct dependency is allowlisted and every allowlist entry is used). */
export function checkAllowlist(root) {
  const errors = [];
  const allowlist = JSON.parse(readFileSync(join(root, "docs/dependencies.json"), "utf8"));
  const npmAllowed = allowlist.npm ?? {};
  const cargoAllowed = allowlist.cargo ?? {};

  const seenNpm = new Set();
  for (const { name, manifest } of npmDependencies(root)) {
    seenNpm.add(name);
    if (!(name in npmAllowed)) {
      errors.push(
        `undeclared npm dependency "${name}" in ${manifest}: add "${name}" to docs/dependencies.json npm with the PRD §4 row or DECISIONS id that admits it`,
      );
    }
  }
  for (const name of Object.keys(npmAllowed)) {
    if (!seenNpm.has(name)) {
      errors.push(
        `stale npm allowlist entry "${name}" in docs/dependencies.json: no workspace manifest declares it`,
      );
    }
  }

  const seenCargo = new Set();
  for (const { name, manifest } of cargoDependencies(root)) {
    seenCargo.add(name);
    if (!(name in cargoAllowed)) {
      errors.push(
        `undeclared cargo dependency "${name}" in ${manifest}: add "${name}" to docs/dependencies.json cargo with the PRD §4 row or DECISIONS id that admits it`,
      );
    }
  }
  for (const name of Object.keys(cargoAllowed)) {
    if (!seenCargo.has(name)) {
      errors.push(
        `stale cargo allowlist entry "${name}" in docs/dependencies.json: no Cargo.toml declares it`,
      );
    }
  }

  return errors;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argIdx = process.argv.indexOf("--root");
  const root = argIdx >= 0 ? resolve(process.argv[argIdx + 1]) : resolve(HERE, "..");
  const errors = checkAllowlist(root);
  if (errors.length) {
    console.error(`check-deps: ${errors.length} problem(s)`);
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  const npmCount = npmDependencies(root).length;
  const cargoCount = cargoDependencies(root).length;
  console.log(
    `check-deps: ${npmCount} npm + ${cargoCount} cargo direct dependencies, all allowlisted`,
  );
}
