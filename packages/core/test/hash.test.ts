import { describe, expect, it } from "vitest";
import {
  CONTENT_ID_LENGTH,
  FNV_OFFSET_BASIS_64,
  FNV_PRIME_64,
  contentHash,
  fnv1a64,
  toBase36,
} from "../src/hash.js";

/** The published algorithm, folded over an explicit byte list, independent of the implementation. */
function fnv1a64OverBytes(bytes: readonly number[]): bigint {
  let hash = FNV_OFFSET_BASIS_64;
  for (const byte of bytes) {
    hash = ((hash ^ BigInt(byte)) * FNV_PRIME_64) & 0xffffffffffffffffn;
  }
  return hash;
}

describe("fnv1a64 (PRD §6.1)", () => {
  it("matches the published FNV-1a 64 test vectors", () => {
    expect(fnv1a64("")).toBe(0xcbf29ce484222325n);
    expect(fnv1a64("hello")).toBe(0xa430d84680aabd0bn);
  });

  it("hashes the empty string to the offset basis and nothing else to it", () => {
    expect(fnv1a64("")).toBe(FNV_OFFSET_BASIS_64);
    expect(fnv1a64("a")).not.toBe(FNV_OFFSET_BASIS_64);
  });

  it("stays inside the unsigned 64-bit range for a long input", () => {
    const hash = fnv1a64("x".repeat(10_000));
    expect(hash).toBeGreaterThanOrEqual(0n);
    expect(hash).toBeLessThanOrEqual(0xffffffffffffffffn);
  });

  it("hashes UTF-8 bytes, not UTF-16 code units", () => {
    // "é" is one UTF-16 code unit (0x00e9) but two UTF-8 bytes (0xc3 0xa9).
    expect(fnv1a64("é")).toBe(fnv1a64OverBytes([0xc3, 0xa9]));
    expect(fnv1a64("é")).not.toBe(fnv1a64OverBytes([0xe9]));
    // An astral character is a surrogate pair in UTF-16 and four bytes in UTF-8.
    expect(fnv1a64("\u{1f58b}")).toBe(fnv1a64OverBytes([0xf0, 0x9f, 0x96, 0x8b]));
  });
});

describe("toBase36 / contentHash", () => {
  it("encodes the published vectors as exactly 13 base-36 characters", () => {
    expect(toBase36(fnv1a64(""))).toHaveLength(CONTENT_ID_LENGTH);
    expect(toBase36(fnv1a64("hello"))).toHaveLength(CONTENT_ID_LENGTH);
    expect(toBase36(fnv1a64("hello"))).toBe("2hvyo96lq8v0r");
    expect(contentHash("hello")).toBe("2hvyo96lq8v0r");
  });

  it("zero-pads short hashes and still fits the largest 64-bit value", () => {
    expect(toBase36(0n)).toBe("0".repeat(CONTENT_ID_LENGTH));
    expect(toBase36(1n)).toBe(`${"0".repeat(CONTENT_ID_LENGTH - 1)}1`);
    // 13 digits is the width the padding is chosen for: the maximum fits exactly, nothing overflows.
    expect(toBase36(0xffffffffffffffffn)).toHaveLength(CONTENT_ID_LENGTH);
    expect((0xffffffffffffffffn).toString(36)).toHaveLength(CONTENT_ID_LENGTH);
  });

  it("uses only lower-case base-36 digits", () => {
    for (const text of ["", "hello", "a much longer block of prose to hash", "é"]) {
      expect(contentHash(text)).toMatch(/^[0-9a-z]{13}$/);
    }
  });
});
