/**
 * FNV-1a, 64-bit, unsigned (PRD §6.1). The hash is carried as a `bigint` because the algorithm is
 * defined on unsigned 64-bit arithmetic and JavaScript numbers cannot represent it exactly; the
 * multiply is masked back to 64 bits on every step.
 */

/** The published FNV-1a 64 offset basis. `fnv1a64('')` is exactly this value. */
export const FNV_OFFSET_BASIS_64 = 0xcbf29ce484222325n;

/** The published FNV 64 prime, 2^40 + 2^8 + 0xb3. */
export const FNV_PRIME_64 = 0x100000001b3n;

const MASK_64 = 0xffffffffffffffffn;

/**
 * The width of a content id's hash part. `(2^64 - 1).toString(36)` is 13 characters, so every
 * 64-bit hash fits in 13 base-36 digits and shorter ones are zero-padded to keep ids fixed-width.
 */
export const CONTENT_ID_LENGTH = 13;

/**
 * Unsigned 64-bit FNV-1a over the UTF-8 bytes of `input`.
 *
 * The string is encoded to UTF-8 first so that the hash of a document does not depend on
 * JavaScript's UTF-16 representation: the same text hashes to the same value here, in Rust, and in
 * any other consumer that follows the published algorithm.
 */
export function fnv1a64(input: string): bigint {
  const bytes = new TextEncoder().encode(input);
  let hash = FNV_OFFSET_BASIS_64;
  for (const byte of bytes) {
    hash = ((hash ^ BigInt(byte)) * FNV_PRIME_64) & MASK_64;
  }
  return hash;
}

/** Encode a 64-bit hash as lower-case base-36, zero-padded to {@link CONTENT_ID_LENGTH}. */
export function toBase36(hash: bigint): string {
  return hash.toString(36).padStart(CONTENT_ID_LENGTH, "0");
}

/** The 13-character base-36 FNV-1a 64 of `text` — the hash part of a block's contentId (§6.1). */
export function contentHash(text: string): string {
  return toBase36(fnv1a64(text));
}
