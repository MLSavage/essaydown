/**
 * The settings dialog's IPC glue (task 2.7), as pure functions over injected I/O — the same split
 * `document-sync.ts` uses — so every rule here is a vitest case (`tests/settings-sync.test.ts`)
 * rather than a WebdriverIO timing. `packages/core`'s `settings.ts` (zod) owns the schema, defaults
 * and the corrupt-file-plus-warning fallback; this module is the one real call site that turns
 * `parseSettings`'s returned warning into the "one logged warning" the acceptance names.
 */

import { parseSettings, serializeSettings, type Settings } from "@essaydown/core";

export type BackendStatus = "available" | "locked" | "unavailable";

export interface HasCoachKeyResult {
  readonly present: boolean;
  readonly backend: BackendStatus;
}

export interface SettingsIO {
  getSettings(): Promise<string | null>;
  setSettings(contents: string): Promise<void>;
  hasCoachKey(): Promise<HasCoachKeyResult>;
  log(message: string): void;
}

/** `get_settings` → validated settings, logging the corrupt-file warning exactly once (task 2.7's
 * acceptance: "Corrupt settings file → defaults + one logged warning"); a missing file (first
 * launch) is not corruption, so `parseSettings` returns no warning and nothing is logged. */
export async function loadSettings(io: SettingsIO): Promise<Settings> {
  const raw = await io.getSettings();
  const { settings, warning } = parseSettings(raw);
  if (warning !== null) io.log(warning);
  return settings;
}

/** `set_settings` with the already-validated, canonically-serialized value. */
export async function saveSettings(io: SettingsIO, settings: Settings): Promise<void> {
  await io.setSettings(serializeSettings(settings));
}

/** The settings dialog's own words for a non-available credential store (task 2.7's description,
 * verbatim); `null` when the store is available, so the dialog shows nothing. */
export function credentialStoreMessage(backend: BackendStatus): string | null {
  if (backend === "available") return null;
  return "Credential store unavailable — set ESSAYDOWN_COACH_KEY or unlock your keychain";
}
