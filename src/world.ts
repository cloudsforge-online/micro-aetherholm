/**
 * Deterministic world generation.
 *
 * An archipelago is generated from a seed and NOTHING else — the Worlds rule that determinism is
 * proven, not claimed (20-aetherholm.md §6). Two calls with one seed must produce byte-identical
 * islands, in order, because the chronicle of a sealed season will one day replay from stored
 * inputs and a generator with hidden state would make that a lie. `world.test.ts` asserts it by
 * comparing serialised output.
 *
 * The PRNG is splitmix64 over `bigint`. Not a *good* generator — an utterly stable one, chosen
 * because its whole state is one u64 and its reference implementation fits in ten lines that will
 * never need a dependency bump. The wind lattice re-rolls from the same seed in phase 2 and must
 * agree with these islands forever.
 */

import { createHash, randomBytes } from 'node:crypto';

const MASK64 = (1n << 64n) - 1n;

/** splitmix64. Returns the next state and a value; pure so a caller can fork deterministically. */
export function splitmix64(state: bigint): { readonly next: bigint; readonly value: bigint } {
  const next = (state + 0x9e3779b97f4a7c15n) & MASK64;
  let z = next;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK64;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK64;
  z = z ^ (z >> 31n);
  return { next, value: z };
}

export const BANDS = ['shallows', 'midreach', 'highwind'] as const;
export type Band = (typeof BANDS)[number];

/** ~200 islands for the public season archipelago (20-aetherholm.md §2). */
export const PUBLIC_ISLAND_COUNT = 200;
/** A Private Skerry is a small private archipelago instance: a dozen isles for a group. */
export const SKERRY_ISLAND_COUNT = 12;
/** 12 city plots + 1 communal Aether well per island, fixed by the design's table in §1. */
export const PLOTS_PER_ISLAND = 12;

export interface GeneratedIsland {
  readonly idx: number;
  readonly band: Band;
  readonly plots: number;
}

/**
 * Generate `count` islands from `seed`.
 *
 * Band distribution is weighted toward the Shallows (roughly 3:2:1) so the rich Highwind isles
 * are scarce — scarcity is the design's engine — but every band is guaranteed present for any
 * count >= 3, because a skerry with no Highwind would be a private world with a system missing.
 */
export function generateIslands(seed: bigint, count: number): readonly GeneratedIsland[] {
  if (!Number.isInteger(count) || count < 3) {
    throw new RangeError(`an archipelago needs at least 3 islands (got ${count})`);
  }
  let state = seed & MASK64;
  const islands: GeneratedIsland[] = [];
  for (let idx = 0; idx < count; idx += 1) {
    const { next, value } = splitmix64(state);
    state = next;
    const roll = Number(value % 6n);
    const band: Band = roll < 3 ? 'shallows' : roll < 5 ? 'midreach' : 'highwind';
    islands.push({ idx, band, plots: PLOTS_PER_ISLAND });
  }
  // Guarantee all three bands exist by pinning the first three indices' bands deterministically
  // when a band came out empty. Deterministic: depends only on what the roll produced.
  const present = new Set(islands.map((island) => island.band));
  let pin = 0;
  for (const band of BANDS) {
    if (!present.has(band)) {
      islands[pin] = { ...islands[pin]!, band };
      pin += 1;
    }
  }
  return islands;
}

/** A fresh 64-bit seed from the platform CSPRNG, as a decimal string for numeric(20,0). */
export function newSeed(random: () => Buffer = randomBytes8): bigint {
  const bytes = random();
  let seed = 0n;
  for (const byte of bytes) seed = (seed << 8n) | BigInt(byte);
  return seed & MASK64;
}

function randomBytes8(): Buffer {
  return randomBytes(8);
}

/**
 * The seed a Private Skerry is generated from: sha256 of the entitlement id, folded to 64 bits.
 *
 * Derived rather than random so the provision path is a pure function of its idempotency key —
 * a replay could not mint a second geography even if the uniqueness constraint were somehow lost.
 */
export function skerrySeed(entitlementId: string): bigint {
  const digest = createHash('sha256').update(entitlementId, 'utf8').digest();
  let seed = 0n;
  for (let index = 0; index < 8; index += 1) seed = (seed << 8n) | BigInt(digest[index]!);
  return seed & MASK64;
}
