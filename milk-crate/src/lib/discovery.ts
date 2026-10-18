/**
 * Discovery on the Artists page: artists you don't follow, a few at a time,
 * a different few each time you come back (or when you ask for others).
 * Ones that sound like who you follow come first; the rest are mixed in an
 * order that changes every day.
 */

/** Same seed, same order. */
export function seededShuffle<T>(items: T[], seed: number): T[] {
  const out = [...items];
  let s = (seed >>> 0) || 1;
  const rand = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Sound-alikes first (in the order given), then everyone else shuffled for the day. */
export function discoveryOrder<T extends { id: string }>(candidates: T[], soundAlikeIds: string[], day: number): T[] {
  const byId = new Map(candidates.map((a) => [a.id, a]));
  const first = soundAlikeIds.map((id) => byId.get(id)).filter(Boolean) as T[];
  const taken = new Set(first.map((a) => a.id));
  return [...first, ...seededShuffle(candidates.filter((a) => !taken.has(a.id)), day)];
}

/** The `turn`-th set of `size` from the list, wrapping around (fewer than `size` only when the list is short). */
export function discoverySet<T>(list: T[], turn: number, size: number): T[] {
  if (list.length <= size) return list;
  const start = ((turn * size) % list.length + list.length) % list.length;
  return Array.from({ length: size }, (_, i) => list[(start + i) % list.length]);
}

export const today = (now = Date.now()) => Math.floor((now - new Date(now).getTimezoneOffset() * 60_000) / 86_400_000);
