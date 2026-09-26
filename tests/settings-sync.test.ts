import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, type Settings } from "../packages/core/src/settings.js";
import {
  credentialStoreMessage,
  loadSettings,
  saveSettings,
  type HasCoachKeyResult,
  type SettingsIO,
} from "../apps/desktop/src/settings/settings-sync.js";

// apps/desktop/src/settings/settings-sync.ts (task 2.7): the settings dialog's IPC glue as pure
// functions over injected I/O, mirroring tests/document-sync.test.ts's harness style.

function io(overrides: Partial<SettingsIO> = {}): SettingsIO & { logs: string[]; written: string[] } {
  const logs: string[] = [];
  const written: string[] = [];
  const base: SettingsIO = {
    getSettings: async () => null,
    setSettings: async (contents) => {
      written.push(contents);
    },
    hasCoachKey: async () => ({ present: false, backend: "available" }),
    log: (message) => logs.push(message),
  };
  return { ...base, ...overrides, logs, written };
}

describe("loadSettings", () => {
  it("returns defaults with no log call when no settings file exists yet", async () => {
    const harness = io({ getSettings: async () => null });
    const settings = await loadSettings(harness);
    expect(settings).toEqual(DEFAULT_SETTINGS);
    expect(harness.logs).toEqual([]);
  });

  it("logs exactly one warning and returns defaults for a corrupt file (acceptance)", async () => {
    const harness = io({ getSettings: async () => "{not json" });
    const settings = await loadSettings(harness);
    expect(settings).toEqual(DEFAULT_SETTINGS);
    expect(harness.logs).toHaveLength(1);
    expect(harness.logs[0]).toMatch(/not valid JSON/);
  });

  it("returns the validated settings with no log call for a well-formed file", async () => {
    const valid: Settings = { ...DEFAULT_SETTINGS, typewriterScroll: true };
    const harness = io({ getSettings: async () => JSON.stringify(valid) });
    const settings = await loadSettings(harness);
    expect(settings).toEqual(valid);
    expect(harness.logs).toEqual([]);
  });
});

describe("saveSettings", () => {
  it("writes the canonically-serialized settings", async () => {
    const harness = io();
    const settings: Settings = { ...DEFAULT_SETTINGS, typewriterScroll: true };
    await saveSettings(harness, settings);
    expect(harness.written).toEqual([JSON.stringify(settings, null, 2)]);
  });
});

describe("credentialStoreMessage", () => {
  it("is null when the backend is available (no message shown)", () => {
    expect(credentialStoreMessage("available")).toBeNull();
  });

  it("names the credential store for a locked backend", () => {
    expect(credentialStoreMessage("locked")).toBe(
      "Credential store unavailable — set ESSAYDOWN_COACH_KEY or unlock your keychain",
    );
  });

  it("names the credential store for an unavailable backend", () => {
    expect(credentialStoreMessage("unavailable")).toBe(
      "Credential store unavailable — set ESSAYDOWN_COACH_KEY or unlock your keychain",
    );
  });
});

describe("HasCoachKeyResult shape (documents the IPC contract loadSettings' sibling call relies on)", () => {
  it("is exercised as {present, backend} only, never the secret", () => {
    const result: HasCoachKeyResult = { present: true, backend: "available" };
    expect(JSON.stringify(result)).not.toMatch(/key|secret/i);
  });
});
