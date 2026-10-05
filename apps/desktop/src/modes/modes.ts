/**
 * The four modes of PRD §6.3 and the chords that switch between them (task 3.1).
 *
 * A mode is a view, never a state of the document (§6.3): it lives in the app, beside the document
 * store, and switching it reads nothing from and writes nothing to the store. That is what makes
 * "switching modes 100× never changes format(root)" hold by construction, and the shell e2e checks
 * it anyway.
 */
export const MODES = ["outline", "produce", "rewrite", "reorder"] as const;
export type Mode = (typeof MODES)[number];

/** The label the mode bar shows for each mode, in bar order. */
export const MODE_LABELS: Readonly<Record<Mode, string>> = {
  outline: "Outline",
  produce: "Produce",
  rewrite: "Rewrite",
  reorder: "Reorder",
};

/**
 * The mode a window opens in: Outline, the first step of §3's workflow and the first button on the
 * bar. Nothing persists the mode across launches; the task does not ask for it.
 */
export const DEFAULT_MODE: Mode = "outline";

/** The part of a `KeyboardEvent` the chord reads. */
export interface ModeKey {
  readonly key: string;
  readonly code: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
}

/**
 * Whether the platform's modifier is Cmd: the test `prosemirror-keymap` makes for its own `Mod-`
 * (`/Mac|iP(hone|[oa]d)/` on `navigator.platform`), so Cmd/Ctrl means the same key here as in the
 * editor's Cmd/Ctrl+Z.
 */
export function isMacPlatform(platform: string): boolean {
  return /Mac|iP(hone|[oa]d)/.test(platform);
}

/**
 * The mode Cmd/Ctrl+1–4 names, or `null` for any other key. Exactly the platform's modifier: Cmd
 * on macOS, Ctrl elsewhere, the other one absent, and no Alt or Shift. The digit is read from
 * `key`, and from `code` (`Digit1`–`Digit4`) for a layout whose unshifted digit row types something
 * else (AZERTY's `&é"'`).
 */
export function modeForKey(event: ModeKey, mac: boolean): Mode | null {
  const mod = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (!mod || event.altKey || event.shiftKey) return null;
  const digit = /^[1-4]$/.test(event.key) ? event.key : /^Digit[1-4]$/.exec(event.code)?.[0].slice(5);
  return digit === undefined ? null : MODES[Number(digit) - 1];
}
