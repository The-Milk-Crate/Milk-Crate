/**
 * Player state for the whole app: queue, transport, ratings and weighted shuffle.
 *
 * Tracks with a `src` play through an <audio> element. A track without audio
 * (none today) would simulate progress so the UI behaves the same either way.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { shuffle, weightedShuffle } from "./shuffle";
import { usePersistentState } from "./storage";
import { isPersistable } from "./localFiles";
import type { Rating, Track } from "./types";

interface PlayerState {
  current?: Track;
  queue: Track[];
  playing: boolean;
  elapsed: number;
  duration: number;
  ratings: Record<string, Rating>;
  weighted: boolean;
  localTracks: Track[];
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
}

const PlayerContext = createContext<(PlayerState & PlayerActions) | null>(null);

export function PlayerProvider({ children }: { children: ReactNode }) {
  const audio = useRef<HTMLAudioElement>(new Audio());
  const [queue, setQueue] = useState<Track[]>([]);
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [duration, setDuration] = useState(0);
  const [ratings, setRatings] = usePersistentState<Record<string, Rating>>("mc.ratings", {});
  const [weighted, setWeighted] = usePersistentState("mc.weightedShuffle", true);
  const [stored, setStored] = usePersistentState<Track[]>("mc.localTracks", []);
  const [sessionTracks, setSessionTracks] = useState<Track[]>([]);

  const current = queue[index];
  const localTracks = useMemo(() => [...stored, ...sessionTracks], [stored, sessionTracks]);

  // Load the current track into the audio element.
  useEffect(() => {
    const el = audio.current;
    setElapsed(0);
    if (current?.src) {
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

  // Play / pause.
  useEffect(() => {
    const el = audio.current;
    if (!current?.src) return;
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
    rate: (trackId: string, rating: Rating) => setRatings((r) => ({ ...r, [trackId]: rating })),
    setWeighted,
    addLocalTracks: (tracks: Track[]) => {
      const keep = tracks.filter(isPersistable);
      const temp = tracks.filter((t) => !isPersistable(t));
      setStored((s) => [...s, ...keep.filter((t) => !s.some((x) => x.id === t.id))]);
      setSessionTracks((s) => [...s, ...temp]);
    },
  };

  return <PlayerContext.Provider value={value}>{children}</PlayerContext.Provider>;
}

export function usePlayer() {
  const ctx = useContext(PlayerContext);
  if (!ctx) throw new Error("usePlayer must be used inside <PlayerProvider>");
  return ctx;
}
