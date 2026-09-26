import { z } from "zod";

// ---------------------------------------------------------------------------
// Schema (task 2.7's description, PRD §6.4)
// ---------------------------------------------------------------------------

/**
 * `theme` has exactly one value: PRD §3 "No themes or theme switcher. One light theme, one dark
 * theme following the OS." The field exists (task 2.7's description names it in the schema) so a
 * settings file always carries it, but there is nothing to switch in v1.
 */
export const THEME_VALUES = ["system"] as const;

export const coachSettingsSchema = z
  .strictObject({
    provider: z.enum(["openai-compatible", "claude-cli"]).nullable().default(null),
    baseUrl: z.string().default(""),
    model: z.string().default(""),
  })
  .strict();
export type CoachSettings = z.infer<typeof coachSettingsSchema>;

/**
 * `.strict()` on both this object and `coach` (§9: "No API key anywhere … in settings JSON") so a
 * stray extra key — a `key`/`apiKey` field from a bug or a hand edit — fails validation instead of
 * surviving a round trip: `parseSettings` treats that the same as any other corrupt file, defaults
 * plus a warning, never carrying the extra key through.
 */
export const settingsSchema = z
  .strictObject({
    theme: z.enum(THEME_VALUES).default("system"),
    typewriterScroll: z.boolean().default(false),
    coach: coachSettingsSchema.default({ provider: null, baseUrl: "", model: "" }),
  })
  .strict();
export type Settings = z.infer<typeof settingsSchema>;

/** The schema's own defaults — first launch, and every corrupt-file fallback. */
export const DEFAULT_SETTINGS: Settings = settingsSchema.parse({});

export interface ParsedSettings {
  readonly settings: Settings;
  /** `null` when `raw` was `null` (no file yet) or validated cleanly; otherwise one message
   * describing why the file was rejected, for the caller to log once (task 2.7's acceptance:
   * "Corrupt settings file → defaults + one logged warning" — this module returns the warning,
   * the caller logs it, so the pure parse itself has no side effect). */
  readonly warning: string | null;
}

/**
 * `get_settings`'s raw file contents (or `null` on first launch) → validated settings, defaulting
 * on any corruption: invalid JSON, or JSON that fails the schema (wrong types, an unknown theme
 * value, a stray key). A missing file (`raw === null`) is not corruption — no warning.
 */
export function parseSettings(raw: string | null): ParsedSettings {
  if (raw === null) return { settings: DEFAULT_SETTINGS, warning: null };

  let candidate: unknown;
  try {
    candidate = JSON.parse(raw);
  } catch (error) {
    // `JSON.parse` always throws a `SyntaxError` (an `Error`) per spec — never a bare value —
    // so there is no second branch here to guard.
    const message = (error as SyntaxError).message;
    return {
      settings: DEFAULT_SETTINGS,
      warning: `Settings file is not valid JSON (${message}); using defaults.`,
    };
  }

  const result = settingsSchema.safeParse(candidate);
  if (!result.success) {
    // `safeParse`'s `issues` is non-empty whenever `success` is `false` (zod's own guarantee), so
    // `issues[0]` is never missing here.
    return {
      settings: DEFAULT_SETTINGS,
      warning: `Settings file failed validation (${result.error.issues[0].message}); using defaults.`,
    };
  }
  return { settings: result.data, warning: null };
}

/** `set_settings`'s payload: canonical JSON for a validated `Settings` value. */
export function serializeSettings(settings: Settings): string {
  return JSON.stringify(settingsSchema.parse(settings), null, 2);
}
