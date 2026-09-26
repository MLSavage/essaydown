import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, parseSettings, serializeSettings, settingsSchema, type Settings } from "../src/settings.js";

describe("DEFAULT_SETTINGS (task 2.7's description)", () => {
  it("matches the described default shape", () => {
    expect(DEFAULT_SETTINGS).toEqual({
      theme: "system",
      typewriterScroll: false,
      coach: { provider: null, baseUrl: "", model: "" },
    });
  });

  it("carries no key field anywhere (task 2.7's description: 'no key field')", () => {
    expect("key" in DEFAULT_SETTINGS.coach).toBe(false);
    expect(JSON.stringify(DEFAULT_SETTINGS)).not.toMatch(/key/i);
  });
});

describe("parseSettings", () => {
  it("returns defaults with no warning when the file does not exist yet", () => {
    const result = parseSettings(null);
    expect(result).toEqual({ settings: DEFAULT_SETTINGS, warning: null });
  });

  it("returns defaults with one warning for a file that is not valid JSON", () => {
    const result = parseSettings("{not json");
    expect(result.settings).toEqual(DEFAULT_SETTINGS);
    expect(result.warning).not.toBeNull();
    expect(result.warning).toMatch(/not valid JSON/);
  });

  it("returns defaults with one warning for well-formed JSON that fails the schema", () => {
    const result = parseSettings(JSON.stringify({ theme: "purple-haze", typewriterScroll: false, coach: {} }));
    expect(result.settings).toEqual(DEFAULT_SETTINGS);
    expect(result.warning).not.toBeNull();
    expect(result.warning).toMatch(/failed validation/);
  });

  it("returns defaults with one warning when the wrong type is used for a field", () => {
    const result = parseSettings(JSON.stringify({ typewriterScroll: "yes" }));
    expect(result.settings).toEqual(DEFAULT_SETTINGS);
    expect(result.warning).not.toBeNull();
  });

  it("returns defaults with one warning when an extra key is present (never carries a stray key field through, §9)", () => {
    const withStrayKey = { theme: "system", typewriterScroll: false, coach: { provider: null, baseUrl: "", model: "", key: "sk-leaked" } };
    const result = parseSettings(JSON.stringify(withStrayKey));
    expect(result.settings).toEqual(DEFAULT_SETTINGS);
    expect(result.warning).not.toBeNull();
    expect(JSON.stringify(result)).not.toContain("sk-leaked");
  });

  it("returns the validated value with no warning for a well-formed file", () => {
    const valid: Settings = {
      theme: "system",
      typewriterScroll: true,
      coach: { provider: "openai-compatible", baseUrl: "http://localhost:11434", model: "llama3" },
    };
    const result = parseSettings(JSON.stringify(valid));
    expect(result).toEqual({ settings: valid, warning: null });
  });

  it("fills in defaults for a partial but validly-shaped file", () => {
    const result = parseSettings(JSON.stringify({ typewriterScroll: true }));
    expect(result).toEqual({ settings: { ...DEFAULT_SETTINGS, typewriterScroll: true }, warning: null });
  });
});

describe("serializeSettings / parseSettings round trip (typewriterScroll persists across relaunch)", () => {
  it("round-trips a settings value byte-for-byte through JSON", () => {
    const settings: Settings = { ...DEFAULT_SETTINGS, typewriterScroll: true };
    const raw = serializeSettings(settings);
    expect(parseSettings(raw)).toEqual({ settings, warning: null });
  });

  it("round-trips both values of typewriterScroll", () => {
    for (const typewriterScroll of [true, false]) {
      const settings: Settings = { ...DEFAULT_SETTINGS, typewriterScroll };
      expect(parseSettings(serializeSettings(settings)).settings.typewriterScroll).toBe(typewriterScroll);
    }
  });

  it("rejects a settings value carrying an extra key before it can ever reach disk", () => {
    const withStrayKey = { ...DEFAULT_SETTINGS, coach: { ...DEFAULT_SETTINGS.coach, key: "sk-leaked" } };
    expect(() => serializeSettings(withStrayKey as Settings)).toThrow();
  });
});

describe("settingsSchema", () => {
  it("accepts both defined coach providers and null", () => {
    for (const provider of ["openai-compatible", "claude-cli", null] as const) {
      expect(settingsSchema.safeParse({ coach: { provider } }).success).toBe(true);
    }
  });

  it("rejects an undefined coach provider value", () => {
    expect(settingsSchema.safeParse({ coach: { provider: "gpt-oss" } }).success).toBe(false);
  });
});
