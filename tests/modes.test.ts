import { describe, expect, it } from "vitest";
import {
  DEFAULT_MODE,
  MODE_LABELS,
  MODES,
  isMacPlatform,
  modeForKey,
  type ModeKey,
} from "../apps/desktop/src/modes/modes.js";

/**
 * The mode bar's chords (task 3.1, Cmd/Ctrl+1–4; apps/desktop/src/modes/modes.ts). The shell e2e
 * presses the real chord on Linux; this file holds one case per guard `modeForKey` adds, on both
 * platforms' modifiers.
 */

function key(init: Partial<ModeKey>): ModeKey {
  return { key: "", code: "", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...init };
}

const PLATFORMS = [
  { label: "macOS", mac: true, mod: { metaKey: true }, other: { ctrlKey: true } },
  { label: "Linux and Windows", mac: false, mod: { ctrlKey: true }, other: { metaKey: true } },
] as const;

describe("the four modes", () => {
  it("are Outline, Produce, Rewrite and Reorder, in bar order, each labelled", () => {
    expect(MODES.map((mode) => MODE_LABELS[mode])).toEqual(["Outline", "Produce", "Rewrite", "Reorder"]);
    expect(MODES).toContain(DEFAULT_MODE);
  });
});

describe("isMacPlatform", () => {
  it("is true for macOS and iOS platforms and false for the others", () => {
    expect(isMacPlatform("MacIntel")).toBe(true);
    expect(isMacPlatform("iPad")).toBe(true);
    expect(isMacPlatform("Linux x86_64")).toBe(false);
    expect(isMacPlatform("Win32")).toBe(false);
  });
});

describe.each(PLATFORMS)("modeForKey on $label", ({ mac, mod, other }) => {
  it("maps the platform's modifier + 1–4 to the four modes in bar order", () => {
    expect(["1", "2", "3", "4"].map((digit) => modeForKey(key({ ...mod, key: digit }), mac))).toEqual([
      ...MODES,
    ]);
  });

  it("reads the digit from `code` when the layout's key is not a digit (AZERTY)", () => {
    expect(modeForKey(key({ ...mod, key: "&", code: "Digit1" }), mac)).toBe("outline");
    expect(modeForKey(key({ ...mod, key: "'", code: "Digit4" }), mac)).toBe("reorder");
  });

  it("ignores digits outside 1–4, by key and by code", () => {
    expect(modeForKey(key({ ...mod, key: "0", code: "Digit0" }), mac)).toBeNull();
    expect(modeForKey(key({ ...mod, key: "5", code: "Digit5" }), mac)).toBeNull();
    expect(modeForKey(key({ ...mod, key: "z", code: "KeyZ" }), mac)).toBeNull();
  });

  it("ignores a digit with no modifier", () => {
    expect(modeForKey(key({ key: "1", code: "Digit1" }), mac)).toBeNull();
  });

  it("ignores the other platform's modifier alone", () => {
    expect(modeForKey(key({ ...other, key: "1", code: "Digit1" }), mac)).toBeNull();
  });

  it("ignores both modifiers together", () => {
    expect(modeForKey(key({ metaKey: true, ctrlKey: true, key: "1", code: "Digit1" }), mac)).toBeNull();
  });

  it("ignores the chord with Alt", () => {
    expect(modeForKey(key({ ...mod, altKey: true, key: "1", code: "Digit1" }), mac)).toBeNull();
  });

  it("ignores the chord with Shift", () => {
    expect(modeForKey(key({ ...mod, shiftKey: true, key: "!", code: "Digit1" }), mac)).toBeNull();
  });
});
