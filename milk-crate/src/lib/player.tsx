/**
 * Player state for the whole app: queue, transport, ratings, weighted shuffle
 * and play history (kept on this computer; feeds "In your rotation").
 *
 * Ratings: Milk Crate songs are rated in your account (library.tsx); files
 * from your own computer are rated on this computer.
 *
 * Tracks with a `src` play through an <audio> element. A track without audio
 * (none today) would simulate progress so the UI behaves the same either way.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { shuffle, weightedShuffle } from "./shuffle";
import { usePersistentState } from "./storage";
import { isPersistable } from "./localFiles";
import type { Rating, Track } from "./types";
import { attempt, useLibrary } from "./library";
import { AudioOut, FLAT } from "./audioOut";

export interface Play { trackId: string; releaseId: string; at: number }
const HISTORY_LIMIT = 500;

interface PlayerState {
  current?: Track;
  queue: Track[];
  playing: boolean;
  elapsed: number;
  duration: number;
  ratings: Record<string, Rating>;
  weighted: boolean;
  localTracks: Track[];
  /** Recent plays, newest first. */
  history: Play[];
  /** 0–1, as on the volume slider. */
  volume: number;
  muted: boolean;
  eqOn: boolean;
  /** Gain in dB for each of the six EQ bands (see audioOut.ts). */
  eqGains: number[];
}

interface PlayerActions {
  playQueue: (tracks: Track[], startAt?: number) => void;
  shuffleAll: (tracks: Track[]) => void;
  toggle: () => void;
  next: () => void;
  prev: () => void;
  seek: (fraction: number) => void;
  rate: (trackId: string, rating: Rating) => void;
  setWeighted: (on: boolean) => void;
  addLocalTracks: (tracks: Track[]) => void;
  removeLocalTrack: (trackId: string) => void;
  setVolume: (v: number) => void;
  setMuted: (m: boolean) => void;
  setEqOn: (on: boolean) => void;
  setEqGains: (gains: number[]) => void;
}

const PlayerContext = createContext<(PlayerState & PlayerActions) | null>(null);

export function PlayerProvider({ children }: { children: ReactNode }) {
  const audio = useRef<HTMLAudioElement>(new Audio());
  const out = useRef<AudioOut | null>(null);
  out.current ??= new AudioOut(audio.current);
  const [volume, setVolume] = usePersistentState("mc.volume", 0.8);
  const [muted, setMuted] = usePersistentState("mc.muted", false);
  const [eqOn, setEqOn] = usePersistentState("mc.eqOn", false);
  const [eqGains, setEqGains] = usePersistentState<number[]>("mc.eqGains", FLAT);
  useEffect(() => out.current!.setVolume(volume, muted), [volume, muted]);
  useEffect(() => out.current!.setEq(eqOn, eqGains), [eqOn, eqGains]);
  const [queue, setQueue] = useState<Track[]>([]);
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [duration, setDuration] = useState(0);
  const library = useLibrary();
  const [localRatings, setLocalRatings] = usePersistentState<Record<string, Rating>>("mc.ratings", {});
  const ratings = useMemo(() => ({ ...localRatings, ...library.myRatings }), [localRatings, library.myRatings]);
  const [history, setHistory] = usePersistentState<Play[]>("mc.history", []);
  const [weighted, setWeighted] = usePersistentState("mc.weightedShuffle", true);
  const [stored, setStored] = usePersistentState<Track[]>("mc.localTracks", []);
  const [sessionTracks, setSessionTracks] = useState<Track[]>([]);

  const current = queue[index];
  const localTracks = useMemo(() => [...stored, ...sessionTracks], [stored, sessionTracks]);

  // Remember what's played (once per track start).
  const currentId = current?.id;
  useEffect(() => {
    if (!current || !playing) return;
    setHistory((h) => (h[0]?.trackId === current.id && Date.now() - h[0].at < 5000 ? h : [{ trackId: current.id, releaseId: current.releaseId, at: Date.now() }, ...h].slice(0, HISTORY_LIMIT)));
  }, [currentId, playing]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load the current track into the audio element.
  useEffect(() => {
    const el = audio.current;
    setElapsed(0);
    if (current?.src) {
      out.current!.prepare(current.src);
      el.src = current.src;
      setDuration(current.duration);
      if (playing) void el.play().catch(() => setPlaying(false));
    } else {
      el.removeAttribute("src");
      el.load();
      setDuration(current?.duration ?? 0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id]);

  // Lets the "now playing" record spin only while music is actually playing.
  useEffect(() => {
    document.documentElement.dataset.playing = playing && current ? "true" : "false";
  }, [playing, current]);

  // Play / pause.
  useEffect(() => {
    const el = audio.current;
    if (!current?.src) return;
    if (playing) out.current!.resume();
    if (playing) void el.play().catch(() => setPlaying(false));
    else el.pause();
  }, [playing, current?.src]);

  const next = useCallback(() => {
    setIndex((i) => {
      if (i + 1 < queue.length) return i + 1;
      setPlaying(false);
      return i;
    });
  }, [queue.length]);

  const prev = useCallback(() => {
    if (elapsed > 3) {
      audio.current.currentTime = 0;
      setElapsed(0);
      return;
    }
    setIndex((i) => Math.max(0, i - 1));
  }, [elapsed]);

  // Real audio events.
  useEffect(() => {
    const el = audio.current;
    const onTime = () => setElapsed(el.currentTime);
    const onMeta = () => Number.isFinite(el.duration) && setDuration(el.duration);
    const onEnded = () => next();
    el.addEventListener("timeupdate", onTime);
    el.addEventListener("loadedmetadata", onMeta);
    el.addEventListener("ended", onEnded);
    return () => {
      el.removeEventListener("timeupdate", onTime);
      el.removeEventListener("loadedmetadata", onMeta);
      el.removeEventListener("ended", onEnded);
    };
  }, [next]);

  // Simulated progress for a track with no audio.
  useEffect(() => {
    if (!playing || !current || current.src) return;
    const id = window.setInterval(() => {
      setElapsed((e) => {
        if (e + 1 >= current.duration) {
          next();
          return 0;
        }
        return e + 1;
      });
    }, 1000);
    return () => window.clearInterval(id);
  }, [playing, current, next]);

  const playQueue = useCallback((tracks: Track[], startAt = 0) => {
    if (!tracks.length) return;
    setQueue(tracks);
    setIndex(startAt);
    setPlaying(true);
  }, []);

  const shuffleAll = useCallback(
    (tracks: Track[]) => {
      const order = weighted ? weightedShuffle(tracks, (t) => ratings[t.id]) : shuffle(tracks);
      playQueue(order, 0);
    },
    [weighted, ratings, playQueue],
  );

  const value = {
    current,
    queue,
    playing,
    elapsed,
    duration,
    ratings,
    weighted,
    localTracks,
    history,
    volume,
    muted,
    eqOn,
    eqGains,
    setVolume: (v: number) => { setVolume(Math.max(0, Math.min(1, v))); if (v > 0) setMuted(false); },
    setMuted,
    setEqOn,
    setEqGains,
    playQueue,
    shuffleAll,
    next,
    prev,
    toggle: () => current && setPlaying((p) => !p),
    seek: (fraction: number) => {
      const to = Math.max(0, Math.min(1, fraction)) * duration;
      if (current?.src) audio.current.currentTime = to;
      setElapsed(to);
    },
    rate: (trackId: string, rating: Rating) => {
      if (trackId.startsWith("local:")) setLocalRatings((r) => ({ ...r, [trackId]: rating }));
      else void attempt(() => library.rate(trackId, rating));
    },
    setWeighted,
    addLocalTracks: (tracks: Track[]) => {
      const keep = tracks.filter(isPersistable);
      const temp = tracks.filter((t) => !isPersistable(t));
      setStored((s) => [...s, ...keep.filter((t) => !s.some((x) => x.id === t.id))]);
      setSessionTracks((s) => [...s, ...temp]);
    },
    removeLocalTrack: (trackId: string) => {
      setStored((s) => s.filter((t) => t.id !== trackId));
      setSessionTracks((s) => s.filter((t) => t.id !== trackId));
    },
  };

  return <PlayerContext.Provider value={value}>{children}</PlayerContext.Provider>;
}

export function usePlayer() {
  const ctx = useContext(PlayerContext);
  if (!ctx) throw new Error("usePlayer must be used inside <PlayerProvider>");
  return ctx;
}
