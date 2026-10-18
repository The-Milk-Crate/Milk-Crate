/**
 * The CD ripper's state, kept outside the page so a rip keeps going while you browse the rest of
 * the app (src/components/CdRipper.tsx shows it; RipNotice tells you when it's done elsewhere).
 */
import { useCallback, useSyncExternalStore } from "react";
import type { CdMatch, Disc, RipProgress, Ripped } from "./cd";

export type Found = "looking" | "found" | "unknown" | "offline";
export interface Draft { album: string; artist: string; year: string; titles: string[]; artists: string[]; cover: string | null }
export interface RipDone { count: number; folder: string; skipped: Ripped["skipped"]; album: string; artist: string; albumKey?: string }

export interface RipState {
  /** The ripper is open on Your Computer. */
  open: boolean;
  /** The ripper is on screen right now (so no notice is needed when a rip finishes). */
  shown: boolean;
  disc: Disc | null | undefined;
  /** The disc the matches below were looked up for. */
  lookedUp?: string;
  matches: CdMatch[];
  pick: number;
  found: Found;
  draft: Draft | null;
  /** The edition whose cover was fetched (so coming back doesn't fetch it over yours). */
  coverFor?: string;
  coverBusy: boolean;
  progress: RipProgress | null;
  ripping: boolean;
  done: RipDone | null;
  error: string;
  notes: string[];
  /** A rip that finished while the ripper wasn't on screen. */
  notice: RipDone | null;
}

let state: RipState = {
  open: false, shown: false, disc: undefined, matches: [], pick: 0, found: "looking", draft: null,
  coverBusy: false, progress: null, ripping: false, done: null, error: "", notes: [], notice: null,
};
const listeners = new Set<() => void>();

export const ripState = () => state;

export function setRip(patch: Partial<RipState> | ((s: RipState) => Partial<RipState>)) {
  state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) };
  listeners.forEach((l) => l());
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

/** One piece of the ripper's state, like useState (functional updates too). */
export function useRip<K extends keyof RipState>(k: K): [RipState[K], (v: RipState[K] | ((old: RipState[K]) => RipState[K])) => void] {
  const value = useSyncExternalStore(subscribe, () => state[k]);
  const set = useCallback((v: RipState[K] | ((old: RipState[K]) => RipState[K])) => {
    setRip((s) => ({ [k]: typeof v === "function" ? (v as (o: RipState[K]) => RipState[K])(s[k]) : v } as Partial<RipState>));
  }, [k]);
  return [value, set];
}
