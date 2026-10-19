/**
 * Recording records (desktop app only): the app side of src-tauri/vinyl.
 * Pick the record (MusicBrainz search), record each side as it plays, check where the songs
 * start, and save them as tagged FLAC in Music › Milk Crate › Artist › Album (Vinyl).
 * The recording's state lives here, outside the page, so it keeps going while you browse.
 */
import { useSyncExternalStore } from "react";
import { isDesktop } from "./localFiles";
import { findSplits } from "./vinylSplit";

export interface Pressing { releaseId: string; title: string; artist: string; year?: string | null; detail: string; tracks: number; vinyl: boolean }
export interface SideTrack { position?: string; title: string; artist: string; seconds?: number | null }
export interface Side { label: string; disc: number; tracks: SideTrack[] }
export interface RecordInfo { releaseId: string; releaseGroupId?: string | null; title: string; artist: string; year?: string | null; discs: number; sides: Side[] }
export interface Input { name: string; default: boolean; likely: boolean }
interface Level { seconds: number; left: number; right: number; env: number[]; quietFor: number; paused: boolean; clipped: boolean; dead?: boolean }
interface Recording { path: string; rate: number; seconds: number; envelope: number[] }

export type Step = "pick" | "record" | "check" | "done";

export interface VinylState {
  open: boolean;
  /** The recorder is on screen (no corner notice needed). */
  shown: boolean;
  step: Step;
  query: string;
  results: Pressing[];
  searching: boolean;
  /** The pressing picked, and its sides (or sides typed in by hand). */
  releaseId?: string;
  releaseGroupId?: string | null;
  album: string;
  artist: string;
  year: string;
  cover: string | null;
  sides: Side[];
  discs: number;
  /** The side being recorded or checked. */
  side: number;
  inputs: Input[];
  device: string;
  recording: boolean;
  paused: boolean;
  seconds: number;
  env: number[];
  left: number;
  right: number;
  quietFor: number;
  clipped: boolean;
  /** Nothing at all is coming in (not even noise): access is off, or the wrong input. */
  dead: boolean;
  /** A side recorded and stopped, waiting to be checked and saved. */
  take: Recording | null;
  start: number;
  end: number;
  cuts: number[];
  unsure: boolean[];
  saving: boolean;
  /** Songs saved so far (all sides). */
  saved: string[];
  error: string;
  /** Recording finished (or the side ended) while you were elsewhere. */
  notice: string | null;
}

const blank: VinylState = {
  open: false, shown: false, step: "pick", query: "", results: [], searching: false, album: "", artist: "", year: "", cover: null,
  sides: [], discs: 1, side: 0, inputs: [], device: "", recording: false, paused: false, seconds: 0, env: [], left: 0, right: 0,
  quietFor: 0, clipped: false, dead: false, take: null, start: 0, end: 0, cuts: [], unsure: [], saving: false, saved: [], error: "", notice: null,
};
let state: VinylState = blank;
const listeners = new Set<() => void>();
export const vinylState = () => state;
export function setVinyl(patch: Partial<VinylState> | ((s: VinylState) => Partial<VinylState>)) {
  state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) };
  listeners.forEach((l) => l());
}
export function useVinyl(): VinylState {
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => state);
}

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

/** Recording records needs the desktop app (it listens to the turntable directly). */
export const canRecordVinyl = isDesktop;

/* ---------- Picking the record ---------- */

export async function searchRecords(query: string) {
  setVinyl({ query, searching: true, error: "" });
  try {
    const results = query.trim() ? await call<Pressing[]>("vinyl_search", { query }) : [];
    if (state.query === query) setVinyl({ results, searching: false });
  } catch (e) {
    setVinyl({ searching: false, error: String(e) });
  }
}

export async function chooseRecord(p: Pressing) {
  setVinyl({ releaseId: p.releaseId, album: p.title, artist: p.artist, year: p.year ?? "", sides: [], cover: null, error: "" });
  try {
    const info = await call<RecordInfo | null>("vinyl_record_info", { releaseId: p.releaseId });
    if (state.releaseId !== p.releaseId) return;
    if (!info || !info.sides.length) {
      setVinyl({ sides: blankSides(), error: "MusicBrainz doesn't list this record's songs. Type them in below." });
      return;
    }
    setVinyl({ releaseGroupId: info.releaseGroupId, album: info.title, artist: info.artist, year: info.year ?? "", sides: info.sides, discs: info.discs, side: 0 });
    const cover = await call<string | null>("cd_cover", { releaseId: p.releaseId }).catch(() => null);
    if (state.releaseId === p.releaseId) setVinyl({ cover });
  } catch (e) {
    setVinyl({ error: String(e), sides: blankSides() });
  }
}

const blankSides = (): Side[] => [{ label: "A", disc: 1, tracks: [] }, { label: "B", disc: 1, tracks: [] }];

/** Typing the songs in by hand: one per line, for each side. */
export function enterByHand() {
  setVinyl({ releaseId: undefined, releaseGroupId: null, cover: null, sides: blankSides(), discs: 1, side: 0, error: "" });
}

export async function loadInputs() {
  try {
    const inputs = await call<Input[]>("vinyl_inputs");
    setVinyl((s) => ({ inputs, device: s.device && inputs.some((i) => i.name === s.device) ? s.device : inputs[0]?.name ?? "" }));
  } catch {
    setVinyl({ inputs: [] });
  }
}

/* ---------- Recording a side ---------- */

let listening: Promise<void> | null = null;
function listenLevels() {
  listening ??= (async () => {
    const { listen } = await import("@tauri-apps/api/event");
    await listen<Level>("vinyl-level", (e) => {
      const l = e.payload;
      if (!state.recording) return;
      setVinyl((s) => ({ seconds: l.seconds, left: l.left, right: l.right, quietFor: l.quietFor, clipped: s.clipped || l.clipped, dead: !!l.dead, env: l.env.length ? [...s.env, ...l.env] : s.env }));
      // The side has ended: a while of quiet after some music.
      if (!l.paused && !l.dead && l.seconds > 60 && l.quietFor >= 8) void stopSide(true);
    });
  })();
  return listening;
}

export async function startSide() {
  await listenLevels();
  setVinyl({ error: "", env: [], seconds: 0, quietFor: 0, clipped: false, dead: false, left: 0, right: 0, take: null, paused: false });
  try {
    await call<{ rate: number }>("vinyl_start", { device: state.device || null });
    setVinyl({ recording: true, step: "record" });
  } catch (e) {
    setVinyl({ recording: false, error: String(e) });
  }
}

export async function pauseSide(paused: boolean) {
  await call("vinyl_pause", { paused }).catch(() => {});
  setVinyl({ paused });
}

/** Stops recording and finds the songs. `ended`: the side ran out on its own. */
export async function stopSide(ended = false) {
  if (!state.recording) return;
  setVinyl({ recording: false });
  try {
    const take = await call<Recording>("vinyl_stop");
    const side = state.sides[state.side];
    const lengths = side?.tracks.map((t) => t.seconds ?? null);
    const n = Math.max(1, side?.tracks.length ?? 1);
    const found = findSplits(take.envelope, lengths && lengths.length === n ? lengths : undefined);
    const fit = fitCuts(found.cuts, found.unsure, n, found.start, found.end);
    setVinyl({ take, step: "check", start: found.start, end: found.end, cuts: fit.cuts, unsure: fit.unsure,
      notice: ended && !state.shown ? `Side ${side?.label ?? ""} of ${state.album || "your record"} is done. Check the songs.` : null });
  } catch (e) {
    setVinyl({ error: String(e), step: "pick" });
  }
}

/** Exactly n−1 cuts for n songs: extra gaps are dropped (the least quiet), missing ones split the longest songs. */
export function fitCuts(cuts: number[], unsure: boolean[], n: number, start: number, end: number) {
  let list = cuts.map((c, i) => ({ c, u: unsure[i] ?? false }));
  while (list.length > n - 1) list.splice(Math.floor(list.length / 2), 1);
  while (list.length < n - 1) {
    const bounds = [start, ...list.map((x) => x.c), end];
    let at = 0;
    for (let i = 1; i < bounds.length - 1; i++) if (bounds[i + 1] - bounds[i] > bounds[at + 1] - bounds[at]) at = i;
    list.push({ c: (bounds[at] + bounds[at + 1]) / 2, u: true });
    list = list.sort((a, b) => a.c - b.c);
  }
  return { cuts: list.map((x) => x.c), unsure: list.map((x) => x.u) };
}

export async function cancelSide() {
  setVinyl({ recording: false });
  await call("vinyl_discard", { path: "" }).catch(() => {});
  if (state.take) await call("vinyl_discard", { path: state.take.path }).catch(() => {});
  setVinyl({ take: null, step: state.saved.length ? "record" : "pick", env: [], seconds: 0 });
}

/* ---------- Checking and saving ---------- */

let preview: HTMLAudioElement | null = null;
/** Plays a few seconds of the recording from `at`. */
export async function playFrom(at: number, seconds = 8) {
  const t = state.take;
  if (!t) return;
  const bytes = await call<ArrayBuffer>("vinyl_snippet", { path: t.path, rate: t.rate, start: Math.max(0, at), seconds });
  preview?.pause();
  preview = new Audio(URL.createObjectURL(new Blob([bytes], { type: "audio/wav" })));
  void preview.play();
}
export const stopPreview = () => preview?.pause();

/** Saves the side's songs. Returns the files (for Your Computer and Your Shelf), or throws. */
export async function saveSide(): Promise<string[]> {
  const s = state;
  const t = s.take;
  const side = s.sides[s.side];
  if (!t || !side) throw new Error("Nothing recorded to save.");
  const bounds = [s.start, ...s.cuts, s.end];
  const before = s.sides.slice(0, s.side).reduce((n, x) => n + x.tracks.length, 0);
  const total = s.sides.reduce((n, x) => n + x.tracks.length, 0);
  const songs = side.tracks.map((tr, i) => ({
    start: bounds[i], end: bounds[i + 1], title: tr.title.trim() || `Track ${before + i + 1}`, artist: tr.artist, track: before + i + 1, disc: side.disc,
  }));
  setVinyl({ saving: true, error: "" });
  try {
    const files = await call<string[]>("vinyl_save", {
      path: t.path, rate: t.rate, cover: s.cover,
      plan: { album: s.album.trim() || "Unknown Album", albumArtist: s.artist.trim() || "Unknown Artist", year: s.year.trim() || null, releaseId: s.releaseId ?? null,
        releaseGroupId: s.releaseGroupId ?? null, tracks: total, discs: s.discs, songs },
    });
    await call("vinyl_discard", { path: t.path }).catch(() => {});
    const last = s.side >= s.sides.length - 1;
    setVinyl({ saving: false, take: null, env: [], seconds: 0, saved: [...s.saved, ...files], side: last ? s.side : s.side + 1, step: last ? "done" : "record" });
    return files;
  } catch (e) {
    setVinyl({ saving: false, error: String(e) });
    throw e;
  }
}

/** Start over with another record. */
export const resetVinyl = () => setVinyl({ ...blank, open: true, shown: state.shown, inputs: state.inputs, device: state.device });
