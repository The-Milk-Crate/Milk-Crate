/**
 * "Sounds like": artists whose music measures closest to artists you follow
 * (tempo, energy, brightness, dynamics, from sound.ts). Artists whose uploads
 * predate sound profiles are matched on shared genres instead, and labeled so.
 * Never based on popularity.
 */
import { averageSound, sharedQualities, soundDistance, type SoundProfile } from "./sound";
import type { Artist, Track } from "./types";

export interface Suggestion { artist: Artist; because: Artist; reason: string; score: number }

const MAX_SOUND_DISTANCE = 0.6;

export function artistSounds(artists: Artist[], tracks: Track[]): Map<string, SoundProfile> {
  const map = new Map<string, SoundProfile>();
  for (const a of artists) {
    const s = averageSound(tracks.filter((t) => t.artistId === a.id && t.sound).map((t) => t.sound!));
    if (s) map.set(a.id, s);
  }
  return map;
}

const norm = (g: string) => g.trim().toLowerCase();

export function similarArtists(seeds: Artist[], candidates: Artist[], sounds: Map<string, SoundProfile>, limit = 12): Suggestion[] {
  const seedIds = new Set(seeds.map((s) => s.id));
  const out: Suggestion[] = [];
  for (const a of candidates) {
    if (seedIds.has(a.id)) continue;
    let best: Suggestion | null = null;
    for (const f of seeds) {
      const sa = sounds.get(a.id), sf = sounds.get(f.id);
      if (sa && sf) {
        const d = soundDistance(sa, sf);
        if (d <= MAX_SOUND_DISTANCE && (!best || d < best.score))
          best = { artist: a, because: f, score: d, reason: `Sounds like ${f.name}: ${sharedQualities(sa, sf)}` };
      } else {
        const ga = new Set(a.genres.map(norm)), gf = f.genres.map(norm);
        const shared = gf.filter((g) => ga.has(g));
        if (shared.length) {
          const score = 1 + 1 / (1 + shared.length);
          if (!best || score < best.score)
            best = { artist: a, because: f, score, reason: `${capitalize(shared[0])}, like ${f.name}` };
        }
      }
    }
    if (best) out.push(best);
  }
  return out.sort((x, y) => x.score - y.score).slice(0, limit);
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
