import type { Rating } from "./types";

/**
 * Weighted shuffle: songs you've rated higher come up more often.
 *
 * Each track gets a weight from its rating; unrated tracks sit in the middle
 * so new music still gets heard. The order is drawn without replacement
 * (Efraimidis–Spirakis), so every track still plays once per pass — a
 * five-star track just tends to come earlier.
 */
export const RATING_WEIGHTS: Record<Rating, number> = {
  0: 1, // unrated — neutral, so new music still surfaces
  1: 0.2,
  2: 0.5,
  3: 1,
  4: 2,
  5: 3.5,
};

export function weightFor(rating: Rating | undefined): number {
  return RATING_WEIGHTS[rating ?? 0];
}

/**
 * Returns a new array in weighted-random order.
 * `random` is injectable so the behavior can be tested deterministically.
 */
export function weightedShuffle<T>(
  items: readonly T[],
  getRating: (item: T) => Rating | undefined,
  random: () => number = Math.random,
): T[] {
  return items
    .map((item) => {
      const w = weightFor(getRating(item));
      // key = u^(1/w); larger keys come first. Higher weight → key closer to 1.
      const u = Math.max(random(), Number.EPSILON);
      return { item, key: Math.pow(u, 1 / w) };
    })
    .sort((a, b) => b.key - a.key)
    .map((x) => x.item);
}

/** Plain uniform shuffle (Fisher–Yates), for when weighted shuffle is off. */
export function shuffle<T>(items: readonly T[], random: () => number = Math.random): T[] {
  const a = items.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
