/**
 * Recording records (desktop app only): the app side of src-tauri/vinyl.
 * Pick the record (MusicBrainz search), record each side as it plays, check where the songs
 * start, and save them as tagged FLAC in Music › Milk Crate › Artist › Album (Vinyl).
 * The recording's state lives here, outside the page, so it keeps going while you browse.
 */
import { useSyncExternalStore } from "react";
import { isDesktop } from "./localFiles";

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
  /** Where each song ends, when it's cut short of the next song's start (null: it runs up to it). */
  ends: (number | null)[];
  unsure: boolean[];
  saving: boolean;
  /** Songs saved so far (all sides). */
  saved: string[];
  /** Sides already saved (by index). */
  doneSides: number[];
  error: string;
  /** Recording finished (or the side ended) while you were elsewhere. */
  notice: string | null;
  /** Recording one song again (from its album page), to replace that song's file. */
  redo: Redo | null;
}

export interface Redo { target: string; trackId: string; albumKey: string; title: string }

const blank: VinylState = {
  open: false, shown: false, step: "pick", query: "", results: [], searching: false, album: "", artist: "", year: "", cover: null,
  sides: [], discs: 1, side: 0, inputs: [], device: "", recording: false, paused: false, seconds: 0, env: [], left: 0, right: 0,
  quietFor: 0, clipped: false, dead: false, take: null, start: 0, end: 0, cuts: [], ends: [], unsure: [], saving: false, saved: [], doneSides: [], error: "", notice: null, redo: null,
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
  setVinyl({ releaseId: p.releaseId, album: p.title, artist: p.artist, year: p.year ?? "", sides: [], cover: null, error: "", side: 0, doneSides: [], saved: [] });
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
  setVinyl({ releaseId: undefined, releaseGroupId: null, cover: null, sides: blankSides(), discs: 1, side: 0, error: "", doneSides: [], saved: [] });
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
      // The side has ended: a full minute of near silence, after some music.
      if (!l.paused && !l.dead && l.quietFor >= END_QUIET && l.seconds - l.quietFor > 15) void stopSide(true);
    });
  })();
  return listening;
}

/** A minute of near silence after the music: the needle is in the run-out groove. */
export const END_QUIET = 60;

/** Which side is about to be recorded (you pick it). */
export const chooseSide = (side: number) => setVinyl({ side });

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

/**
 * Stops recording. The songs' starts are yours to set on the next step: they begin evenly spaced
 * across the side, and the side ends where the closing minute of silence began.
 * `ended`: the side ran out on its own.
 */
export async function stopSide(ended = false) {
  if (!state.recording) return;
  const quiet = ended ? state.quietFor : 0;
  setVinyl({ recording: false });
  try {
    const take = await call<Recording>("vinyl_stop");
    const side = state.sides[state.side];
    const n = Math.max(1, side?.tracks.length ?? 1);
    const end = Math.max(1, take.seconds - Math.min(quiet, take.seconds - 1) + (ended ? 2 : 0));
    const cuts = Array.from({ length: n - 1 }, (_, i) => (end * (i + 1)) / n);
    setVinyl({ take, step: "check", start: 0, end: Math.min(end, take.seconds), cuts, ends: Array.from({ length: n }, () => null), unsure: cuts.map(() => false),
      notice: ended && !state.shown ? (state.redo ? `${state.redo.title} is recorded. Check it.` : `Side ${side?.label ?? ""} of ${state.album || "your record"} is done. Check the songs.`) : null });
  } catch (e) {
    setVinyl({ error: String(e), step: "pick" });
  }
}

export async function cancelSide() {
  setVinyl({ recording: false });
  await call("vinyl_discard", { path: "" }).catch(() => {});
  if (state.take) await call("vinyl_discard", { path: state.take.path }).catch(() => {});
  setVinyl({ take: null, step: state.saved.length || state.redo ? "record" : "pick", env: [], seconds: 0 });
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
  const ends = songEnds(s);
  const before = s.sides.slice(0, s.side).reduce((n, x) => n + x.tracks.length, 0);
  const total = s.sides.reduce((n, x) => n + x.tracks.length, 0);
  const songs = side.tracks.map((tr, i) => ({
    start: bounds[i], end: ends[i], title: tr.title.trim() || `Track ${before + i + 1}`, artist: tr.artist, track: before + i + 1, disc: side.disc,
  }));
  setVinyl({ saving: true, error: "" });
  try {
    const files = await call<string[]>("vinyl_save", {
      path: t.path, rate: t.rate, cover: s.cover,
      plan: { album: s.album.trim() || "Unknown Album", albumArtist: s.artist.trim() || "Unknown Artist", year: s.year.trim() || null, releaseId: s.releaseId ?? null,
        releaseGroupId: s.releaseGroupId ?? null, tracks: total, discs: s.discs, songs },
    });
    await call("vinyl_discard", { path: t.path }).catch(() => {});
    const done = [...s.doneSides, s.side];
    const next = s.sides.findIndex((_, i) => !done.includes(i));
    setVinyl({ saving: false, take: null, env: [], seconds: 0, saved: [...s.saved, ...files], doneSides: done, side: next < 0 ? s.side : next, step: next < 0 ? "done" : "record" });
    return files;
  } catch (e) {
    setVinyl({ saving: false, error: String(e) });
    throw e;
  }
}

/** Where each song ends (seconds): its own end if it was cut short, else where the next one starts. */
export function songEnds(s: Pick<VinylState, "start" | "cuts" | "end" | "ends">): number[] {
  const starts = [s.start, ...s.cuts];
  return starts.map((at, i) => {
    const next = i === starts.length - 1 ? s.end : starts[i + 1];
    const own = s.ends[i];
    return own == null ? next : Math.max(at + 1, Math.min(next, own));
  });
}

/* ---------- Recording one song again ---------- */

/** Opens the recorder to record one song of a record again (it replaces that song's file). */
export function startRedo(r: Redo & { album: string; artist: string; disc?: number }): string | null {
  if (state.recording || state.take) return "The recorder is busy with another record. Finish or cancel that first.";
  setVinyl({ ...blank, open: true, shown: state.shown, inputs: state.inputs, device: state.device, step: "record",
    album: r.album, artist: r.artist, redo: { target: r.target, trackId: r.trackId, albumKey: r.albumKey, title: r.title },
    sides: [{ label: "", disc: r.disc ?? 1, tracks: [{ title: r.title, artist: r.artist }] }], side: 0 });
  if (!state.inputs.length) void loadInputs();
  return null;
}

/** Replaces the song's file with the new recording (between the start and end you set). Returns its new length. */
export async function replaceSong(): Promise<number> {
  const s = state;
  const t = s.take;
  if (!t || !s.redo) throw new Error("Nothing recorded to save.");
  setVinyl({ saving: true, error: "" });
  try {
    const seconds = await call<number>("vinyl_replace", { path: t.path, rate: t.rate, start: s.start, end: songEnds(s)[0], target: s.redo.target });
    await call("vinyl_discard", { path: t.path }).catch(() => {});
    setVinyl({ ...blank, open: false, shown: s.shown, inputs: s.inputs, device: s.device });
    return seconds;
  } catch (e) {
    setVinyl({ saving: false, error: String(e) });
    throw e;
  }
}

/** Closes the recorder (after a song recorded again, or giving up on it). */
export const closeVinyl = () => setVinyl(state.redo ? { ...blank, inputs: state.inputs, device: state.device, shown: state.shown } : { open: false });

/** Start over with another record. */
export const resetVinyl = () => setVinyl({ ...blank, open: true, shown: state.shown, inputs: state.inputs, device: state.device });
