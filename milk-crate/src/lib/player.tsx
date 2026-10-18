/**
 * Player state for the whole app: queue, transport, favorites, weighted shuffle
 * and listening history (in your account when signed in, and on this computer;
 * feeds "In your rotation" and Your Crate → History). The queue is remembered
 * between restarts.
 *
 * Favorites: Milk Crate songs are favorited in your account (library.tsx);
 * files from your own computer are favorited on this computer.
 *
 * Tracks with a `src` play through an <audio> element. A track without audio
 * (none today) would simulate progress so the UI behaves the same either way.
 *
 * The queue can be edited while it plays (play next, add, remove, reorder).
 * Repeat: off, the whole queue, or one song. The next song is fetched ahead of
 * time so it starts right away; downloaded songs play from this computer.
 * Media keys and the system's now-playing controls work through MediaSession.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { shuffle, songWeight, weightedShuffle } from "./shuffle";
import { load, save, usePersistentState } from "./storage";
import { useAuth } from "./auth";
import { mergeHistory, useAccountHistory, type Play } from "./history";
import { isPersistable } from "./localFiles";
import { computerKey, fileArtist, loadComputerTracks } from "./fileTags";
import type { Track } from "./types";
import { attempt, useLibrary } from "./library";
import { AudioOut, FLAT } from "./audioOut";
import { normalizerGainDb, type Loudness } from "./loudness";
import { cachedLoudness, measureTrack } from "./normalizer";
import { useDownloads } from "./downloads";
import { useCatalog } from "./catalog";
import { supabase } from "./supabase";

export type Repeat = "off" | "all" | "one";
/** A song counts as played (for artists' stats) after this long, or half of it if it's shorter. */
const COUNTED_AFTER_S = 30;

export type { Play } from "./history";
const HISTORY_LIMIT = 500;
/** The queue (song ids and where you were), so it's still there after a restart. */
const QUEUE_KEY = "mc.queue";
/** A CD ripped on this computer: its album in Your Computer, and when it was ripped. */
export interface RippedCd { key: string; at: number }
const rippedKey = (userId?: string) => (userId ? `mc.rippedCds.${userId}` : "mc.rippedCds");

interface PlayerState {
  current?: Track;
  queue: Track[];
  /** Position of the playing song in the queue. */
  index: number;
  repeat: Repeat;
  playing: boolean;
  elapsed: number;
  duration: number;
  /** Favorite songs: your account's, plus files on this computer you favorited. */
  favorites: Set<string>;
  weighted: boolean;
  localTracks: Track[];
  /** The radio that's filling the queue, if one is on ("Durham radio"). */
  radio: string | null;
  /** Recent plays, newest first. */
  history: Play[];
  /** 0–1, as on the volume slider. */
  volume: number;
  muted: boolean;
  eqOn: boolean;
  /** Gain in dB for each of the six EQ bands (see audioOut.ts). */
  eqGains: number[];
  /** Plays every song at the same loudness (see loudness.ts). Experimental. */
  normalizerOn: boolean;
  /** The Normalizer's change for the playing song in dB, or null while it's measuring. */
  normalizerDb: number | null;
}

interface PlayerActions {
  playQueue: (tracks: Track[], startAt?: number) => void;
  /** Right after the playing song. */
  playNext: (tracks: Track[]) => void;
  /**
   * Starts a radio: plays `fill`'s songs and asks it for more whenever only a couple
   * are left, so it never stops. `fill` gets the songs to avoid (just heard or queued).
   * Playing anything else ends the radio.
   */
  startRadio: (name: string, fill: (avoid: Set<string>, lastArtist?: string) => Track[]) => void;
  stopRadio: () => void;
  /** Plays one song right now, keeping the rest of the queue after it. */
  playNow: (track: Track) => void;
  /** Clears your listening history (in your account and on this computer). */
  clearHistory: () => Promise<void>;
  /** At the end of the queue. */
  addToQueue: (tracks: Track[]) => void;
  removeFromQueue: (index: number) => void;
  moveInQueue: (from: number, to: number) => void;
  jumpTo: (index: number) => void;
  clearUpNext: () => void;
  setRepeat: (r: Repeat) => void;
  /** Shuffle button: the songs after the one playing come in a mixed-up order (by your favorites when weighted). */
  shuffleOn: boolean;
  setShuffle: (on: boolean) => void;
  shuffleAll: (tracks: Track[]) => void;
  toggle: () => void;
  next: () => void;
  prev: () => void;
  seek: (fraction: number) => void;
  isFavorite: (trackId: string) => boolean;
  /** Favorites a song, or un-favorites it if it already is. */
  toggleFavorite: (trackId: string) => void;
  setWeighted: (on: boolean) => void;
  addLocalTracks: (tracks: Track[]) => void;
  /** Saves new details (tags read from the files) for files already added. */
  updateLocalTracks: (tracks: Track[]) => void;
  removeLocalTrack: (trackId: string) => void;
  /** CDs ripped on this computer (by Your Computer album key), newest first. Kept on this computer only. */
  rippedCds: RippedCd[];
  addRippedCd: (key: string) => void;
  removeRippedCd: (key: string) => void;
  setVolume: (v: number) => void;
  setMuted: (m: boolean) => void;
  setEqOn: (on: boolean) => void;
  setEqGains: (gains: number[]) => void;
  setNormalizerOn: (on: boolean) => void;
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
  const [normalizerOn, setNormalizerOn] = usePersistentState("mc.normalizer", false);
  const [loudness, setLoudness] = useState<Record<string, Loudness>>(cachedLoudness);
  const [queue, setQueue] = useState<Track[]>([]);
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [duration, setDuration] = useState(0);
  const library = useLibrary();
  // Files from this computer: favorites stay here. (Ones you had rated 5 stars start out as favorites.)
  const [startingLocalFavorites] = useState(fiveStarLocal);
  const [localFavorites, setLocalFavorites] = usePersistentState<string[]>("mc.localFavorites", startingLocalFavorites);
  const favorites = useMemo(() => new Set([...localFavorites, ...library.favorites]), [localFavorites, library.favorites]);
  const [localHistory, setLocalHistory] = usePersistentState<Play[]>("mc.history", []);
  const auth = useAuth();
  const catalog = useCatalog();
  const account = useAccountHistory(auth.userId, localHistory, (id) => catalog.trackById[id]?.releaseId);
  // Signed in: your account's history (plus files from this computer). Otherwise this computer's.
  const history = useMemo(() => {
    const h = account.plays ? mergeHistory(account.plays, localHistory) : localHistory;
    return h.map((x) => (x.releaseId ? x : { ...x, releaseId: catalog.trackById[x.trackId]?.releaseId ?? "" }));
  }, [account.plays, localHistory, catalog.trackById]);
  const [weighted, setWeighted] = usePersistentState("mc.weightedShuffle", true);
  // Files from this computer: each account on this computer has its own list.
  const [computer, setComputer] = useState(() => ({ user: auth.userId, tracks: loadComputerTracks(auth.userId) }));
  if (computer.user !== auth.userId) setComputer({ user: auth.userId, tracks: loadComputerTracks(auth.userId) });
  useEffect(() => save(computerKey(computer.user), computer.tracks), [computer]);
  const stored = computer.tracks;
  const setStored = useCallback((f: (s: Track[]) => Track[]) => setComputer((c) => ({ ...c, tracks: f(c.tracks) })), []);
  const [sessionTracks, setSessionTracks] = useState<Track[]>([]);
  // Ripped CDs: like Your Computer, each account on this computer has its own list, and it never leaves it.
  const [ripped, setRipped] = useState(() => ({ user: auth.userId, cds: load<RippedCd[]>(rippedKey(auth.userId), []) }));
  if (ripped.user !== auth.userId) setRipped({ user: auth.userId, cds: load<RippedCd[]>(rippedKey(auth.userId), []) });
  useEffect(() => save(rippedKey(ripped.user), ripped.cds), [ripped]);

  const dl = useDownloads();
  const [radio, setRadio] = useState<{ name: string; fill: (avoid: Set<string>, lastArtist?: string) => Track[] } | null>(null);
  const current = queue[index];
  const upNext = queue[index + 1];

  // Normalizer: measure the playing song and the next one (once each), and set the level.
  useEffect(() => {
    if (!normalizerOn) return;
    let live = true;
    for (const t of [current, upNext]) {
      if (!t?.src || loudness[t.id]) continue;
      void measureTrack(t).then((l) => { if (l && live) setLoudness((m) => ({ ...m, [t.id]: l })); });
    }
    return () => { live = false; };
  }, [normalizerOn, current, upNext, loudness]);
  const measured = current ? loudness[current.id] : undefined;
  const normalizerDb = measured ? normalizerGainDb(measured) : null;
  useEffect(() => out.current!.setNormalizer(normalizerOn, normalizerDb, current?.id), [normalizerOn, normalizerDb, current?.id]);

  const localTracks = useMemo(() => [...stored, ...sessionTracks], [stored, sessionTracks]);

  // Remember what's played (once per track start).
  const currentId = current?.id;
  useEffect(() => {
    if (!current || !playing) return;
    if (localHistory[0]?.trackId === current.id && Date.now() - localHistory[0].at < 5000) return;
    const play = { trackId: current.id, releaseId: current.releaseId, at: Date.now() };
    setLocalHistory((h) => [play, ...h].slice(0, HISTORY_LIMIT));
    account.add(play);
  }, [currentId, playing]); // eslint-disable-line react-hooks/exhaustive-deps

  // Remember the queue, and bring it back (paused) after a restart once the songs are known.
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current) return;
    if (queue.length) { restored.current = true; return; }
    if (catalog.status === "loading") return;
    restored.current = true;
    const saved = load<{ ids: string[]; index: number } | null>(QUEUE_KEY, null);
    if (!saved?.ids?.length) return;
    const local = new Map([...stored].map((t) => [t.id, t]));
    const tracks = saved.ids.map((id) => catalog.trackById[id] ?? local.get(id)).filter(Boolean) as Track[];
    if (!tracks.length) return;
    // Same position if every song is still there; otherwise the first copy of the song you were on.
    const at = tracks.length === saved.ids.length ? Math.min(saved.index, tracks.length - 1) : Math.max(0, tracks.findIndex((t) => t.id === saved.ids[saved.index]));
    setQueue(tracks);
    setIndex(at);
  }, [catalog.status, catalog.trackById]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!restored.current) return;
    // Files picked just for this session can't come back, so they aren't saved.
    const keep = queue.filter((t) => !t.id.startsWith("local:") || stored.some((s) => s.id === t.id));
    save(QUEUE_KEY, keep.length ? { ids: keep.map((t) => t.id), index: Math.max(0, keep.findIndex((t) => t === queue[index])) } : null);
  }, [queue, index, stored]);

  // Load the current track into the audio element (from this computer if it's downloaded).
  // `loadTick` reloads even when the same song comes up again (repeat, or twice in a row).
  const [loadTick, setLoadTick] = useState(0);
  const loadedFor = useRef<string | undefined>(undefined);
  const playingRef = useRef(playing);
  playingRef.current = playing;
  useEffect(() => {
    const el = audio.current;
    let live = true;
    loadedFor.current = undefined;
    setElapsed(0);
    if (current?.src) {
      setDuration(current.duration);
      const start = (src: string) => {
        if (!live) return;
        out.current!.prepare(src);
        el.src = src;
        loadedFor.current = current.id;
        if (playingRef.current) void el.play().catch(() => setPlaying(false));
      };
      if (dl.byTrack[current.id]) void dl.localUrl(current.id).then((u) => start(u ?? current.src!));
      else start(current.src);
    } else {
      el.removeAttribute("src");
      el.load();
      setDuration(current?.duration ?? 0);
    }
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id, loadTick]);

  // Lets the "now playing" record spin only while music is actually playing.
  useEffect(() => {
    document.documentElement.dataset.playing = playing && current ? "true" : "false";
  }, [playing, current]);

  // Play / pause (once the song is loaded; the loader starts it otherwise).
  useEffect(() => {
    const el = audio.current;
    if (!current?.src || loadedFor.current !== current.id) return;
    if (playing) out.current!.resume();
    if (playing) void el.play().catch(() => setPlaying(false));
    else el.pause();
  }, [playing, current?.src, current?.id]);

  const [repeat, setRepeat] = usePersistentState<Repeat>("mc.repeat", "off");
  const repeatRef = useRef(repeat);
  repeatRef.current = repeat;
  const queueLen = useRef(0);
  queueLen.current = queue.length;

  const next = useCallback(() => {
    setIndex((i) => {
      if (i + 1 < queueLen.current) return i + 1;
      if (repeatRef.current === "all" && queueLen.current) return 0;
      setPlaying(false);
      return i;
    });
    setLoadTick((t) => t + 1);
  }, []);

  const prev = useCallback(() => {
    if (elapsed > 3) {
      audio.current.currentTime = 0;
      setElapsed(0);
      return;
    }
    setIndex((i) => (i > 0 ? i - 1 : repeatRef.current === "all" && queueLen.current ? queueLen.current - 1 : 0));
    setLoadTick((t) => t + 1);
  }, [elapsed]);

  // Real audio events.
  useEffect(() => {
    const el = audio.current;
    const onTime = () => setElapsed(el.currentTime);
    const onMeta = () => Number.isFinite(el.duration) && setDuration(el.duration);
    const onEnded = () => {
      if (repeatRef.current === "one") {
        el.currentTime = 0;
        void el.play().catch(() => setPlaying(false));
      } else next();
    };
    el.addEventListener("timeupdate", onTime);
    el.addEventListener("loadedmetadata", onMeta);
    el.addEventListener("ended", onEnded);
    return () => {
      el.removeEventListener("timeupdate", onTime);
      el.removeEventListener("loadedmetadata", onMeta);
      el.removeEventListener("ended", onEnded);
    };
  }, [next]);

  // Fetch the next song ahead of time, so it starts the moment this one ends.
  const preload = useRef<HTMLAudioElement | null>(null);
  const following = upNext ?? (repeat === "all" ? queue[0] : undefined);
  useEffect(() => {
    if (!following?.src || following.id === current?.id || dl.byTrack[following.id] || !/^https?:/.test(following.src)) return;
    const el = (preload.current ??= new Audio());
    el.preload = "auto";
    el.muted = true;
    if (audio.current.crossOrigin) el.crossOrigin = audio.current.crossOrigin;
    else el.removeAttribute("crossorigin");
    el.src = following.src;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [following?.id]);

  // Count a play for the artist's stats once it's been listened to for a bit (Milk Crate songs only).
  const counted = useRef<string>("");
  useEffect(() => {
    if (!current || current.id.startsWith("local:") || !playing) return;
    const key = `${current.id}:${loadTick}`;
    if (counted.current === key) return;
    const need = Math.min(COUNTED_AFTER_S, (current.duration || duration || 60) / 2);
    if (elapsed >= need) {
      counted.current = key;
      void Promise.resolve(supabase.from("plays").insert({ track_id: current.id })).catch(() => {});
    }
  }, [elapsed, current, playing, loadTick, duration]);

  // Media keys and the system's now-playing controls.
  const cat = useCatalog();
  const nowArtist = current ? cat.artistById[current.artistId]?.name ?? fileArtist(current) : "";
  const nowRelease = current ? cat.releaseById[current.releaseId] : undefined;
  const actions = useRef({ next, prev, toggle: () => {}, seekTo: (_s: number) => {} });
  actions.current = {
    next,
    prev,
    toggle: () => current && setPlaying((p) => !p),
    seekTo: (sec: number) => { if (current?.src) audio.current.currentTime = sec; setElapsed(sec); },
  };
  useEffect(() => {
    const ms = typeof navigator !== "undefined" ? navigator.mediaSession : undefined;
    if (!ms) return;
    const set = (a: MediaSessionAction, h: MediaSessionActionHandler | null) => { try { ms.setActionHandler(a, h); } catch { /* not supported */ } };
    set("play", () => setPlaying(true));
    set("pause", () => setPlaying(false));
    set("previoustrack", () => actions.current.prev());
    set("nexttrack", () => actions.current.next());
    set("seekto", (d) => d.seekTime !== undefined && actions.current.seekTo(d.seekTime));
    return () => { for (const a of ["play", "pause", "previoustrack", "nexttrack", "seekto"] as MediaSessionAction[]) set(a, null); };
  }, []);
  useEffect(() => {
    const ms = typeof navigator !== "undefined" ? navigator.mediaSession : undefined;
    if (!ms) return;
    try {
      ms.metadata = current
        ? new MediaMetadata({ title: current.title, artist: nowArtist || "Your files", album: nowRelease?.title ?? "", artwork: nowRelease?.art ? [{ src: nowRelease.art, sizes: "512x512" }] : [] })
        : null;
    } catch { /* not supported */ }
  }, [current, nowArtist, nowRelease]);
  useEffect(() => {
    const ms = typeof navigator !== "undefined" ? navigator.mediaSession : undefined;
    if (ms) ms.playbackState = current ? (playing ? "playing" : "paused") : "none";
  }, [playing, current]);

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
    setLoadTick((t) => t + 1);
    setPlaying(true);
  }, []);

  // Editing the queue while it plays.
  const playNext = (tracks: Track[]) => {
    if (!tracks.length) return;
    if (!queue.length) return playQueue(tracks);
    setQueue((q) => [...q.slice(0, index + 1), ...tracks, ...q.slice(index + 1)]);
  };
  const playNow = (track: Track) => {
    if (!queue.length) return playQueue([track]);
    setQueue((q) => [...q.slice(0, index + 1), track, ...q.slice(index + 1)]);
    setIndex(index + 1);
    setLoadTick((t) => t + 1);
    setPlaying(true);
  };
  // Radio: keep a few songs ahead.
  useEffect(() => {
    if (!radio || !queue.length || queue.length - index - 1 >= 3) return;
    const avoid = new Set([...queue.slice(Math.max(0, index - 30)).map((t) => t.id), ...history.slice(0, 40).map((h) => h.trackId)]);
    const more = radio.fill(avoid, queue[queue.length - 1]?.artistId);
    if (more.length) setQueue((q) => [...q, ...more]);
  }, [radio, index, queue.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const startRadio = (name: string, fill: (avoid: Set<string>, lastArtist?: string) => Track[]) => {
    const first = fill(new Set(history.slice(0, 40).map((h) => h.trackId)));
    if (!first.length) return;
    playQueue(first);
    setRadio({ name, fill });
  };

  const addToQueue = (tracks: Track[]) => {
    if (!tracks.length) return;
    if (!queue.length) return playQueue(tracks);
    setQueue((q) => [...q, ...tracks]);
  };
  const removeFromQueue = (i: number) => {
    if (i < 0 || i >= queue.length) return;
    const rest = queue.filter((_, j) => j !== i);
    setQueue(rest);
    if (!rest.length) {
      setIndex(0);
      setPlaying(false);
    } else if (i < index) setIndex(index - 1);
    else if (i === index) {
      // The playing song was removed: go on to the one after it.
      if (index >= rest.length) { setIndex(rest.length - 1); setPlaying(false); }
      setLoadTick((t) => t + 1);
    }
  };
  const moveInQueue = (from: number, to: number) => {
    if (from === to || from < 0 || to < 0 || from >= queue.length || to >= queue.length) return;
    const q = [...queue];
    const [t] = q.splice(from, 1);
    q.splice(to, 0, t);
    setQueue(q);
    if (from === index) setIndex(to);
    else if (from < index && to >= index) setIndex(index - 1);
    else if (from > index && to <= index) setIndex(index + 1);
  };
  const jumpTo = (i: number) => {
    if (i < 0 || i >= queue.length) return;
    setIndex(i);
    setLoadTick((t) => t + 1);
    setPlaying(true);
  };
  const clearUpNext = () => setQueue((q) => q.slice(0, index + 1));

  const shuffleAll = useCallback(
    (tracks: Track[]) => {
      const order = weighted ? weightedShuffle(tracks, (t) => songWeight(favorites.has(t.id), library.albumRatings[t.releaseId])) : shuffle(tracks);
      playQueue(order, 0);
    },
    [weighted, favorites, library.albumRatings, playQueue],
  );

  // The shuffle button. Turning it on mixes up what's after the playing song; turning it off puts the
  // queue back in its original order (with anything added meanwhile at the end), still on the same song.
  const [shuffleOn, setShuffleOn] = usePersistentState("mc.shuffleOn", false);
  const unshuffled = useRef<Track[] | null>(null);
  const mix = (tracks: Track[]) =>
    weighted ? weightedShuffle(tracks, (t) => songWeight(favorites.has(t.id), library.albumRatings[t.releaseId])) : shuffle(tracks);
  const setShuffle = (on: boolean) => {
    setShuffleOn(on);
    if (on) {
      unshuffled.current = queue;
      setQueue([...queue.slice(0, index + 1), ...mix(queue.slice(index + 1))]);
    } else if (unshuffled.current) {
      const orig = unshuffled.current;
      unshuffled.current = null;
      const inQueue = new Set(queue);
      const wasThere = new Set(orig);
      const back = [...orig.filter((t) => inQueue.has(t)), ...queue.filter((t) => !wasThere.has(t))];
      setQueue(back);
      setIndex(Math.max(0, back.indexOf(queue[index])));
    }
  };

  // Space plays/pauses anywhere in the app, except while typing, or when a control the keyboard has
  // moved to would use Space itself. (Immersive mode handles its own keys.)
  const toggleRef = useRef<() => void>(() => {});
  toggleRef.current = () => current && setPlaying((p) => !p);
  const hasTrack = !!current;
  useEffect(() => {
    // Whether focus last moved by keyboard (Tab, arrows) rather than a click. (Can't use :focus-visible:
    // the browser turns it on for any focused element the moment a key is pressed.)
    let keyboardFocus = false;
    const onPointer = () => { keyboardFocus = false; };
    const onNav = (e: KeyboardEvent) => { if (e.key !== " ") keyboardFocus = true; };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== " " || e.repeat || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      if (!hasTrack || document.querySelector(".immersive")) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest?.("textarea, select, [contenteditable='true'], [contenteditable='']")) return;
      if (t instanceof HTMLInputElement && !["range", "checkbox", "radio", "button", "submit"].includes(t.type)) return;
      const control = t?.closest?.("button, a[href], summary, input, [role=button], [role=switch], [role=tab], [role=link], [role=checkbox], [role=option], [role=menuitem]");
      if (control && keyboardFocus) return; // reached by keyboard: Space presses the control, as usual
      e.preventDefault();
      toggleRef.current();
    };
    window.addEventListener("pointerdown", onPointer, true);
    window.addEventListener("keydown", onNav, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointer, true);
      window.removeEventListener("keydown", onNav, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [hasTrack]);

  const value = {
    current,
    queue,
    index,
    repeat,
    setRepeat,
    shuffleOn,
    setShuffle,
    playNext,
    playNow,
    startRadio,
    stopRadio: () => setRadio(null),
    radio: radio?.name ?? null,
    clearHistory: async () => {
      setLocalHistory([]);
      await account.clear();
    },
    addToQueue,
    removeFromQueue,
    moveInQueue,
    jumpTo,
    clearUpNext: () => { setRadio(null); clearUpNext(); },
    playing,
    elapsed,
    duration,
    favorites,
    weighted,
    localTracks,
    history,
    volume,
    muted,
    eqOn,
    eqGains,
    normalizerOn,
    normalizerDb,
    setNormalizerOn,
    setVolume: (v: number) => { setVolume(Math.max(0, Math.min(1, v))); if (v > 0) setMuted(false); },
    setMuted,
    setEqOn,
    setEqGains,
    // Choosing something else to play ends the radio.
    // With shuffle on, the song you picked plays first and the rest come mixed up.
    playQueue: (tracks: Track[], startAt = 0) => {
      setRadio(null);
      unshuffled.current = shuffleOn && tracks.length > 1 ? tracks : null;
      if (!unshuffled.current) return playQueue(tracks, startAt);
      playQueue([tracks[startAt], ...mix(tracks.filter((_, i) => i !== startAt))], 0);
    },
    shuffleAll: (tracks: Track[]) => { setRadio(null); unshuffled.current = tracks; shuffleAll(tracks); },
    next,
    prev,
    toggle: () => current && setPlaying((p) => !p),
    seek: (fraction: number) => {
      const to = Math.max(0, Math.min(1, fraction)) * duration;
      if (current?.src) audio.current.currentTime = to;
      setElapsed(to);
    },
    isFavorite: (trackId: string) => favorites.has(trackId),
    toggleFavorite: (trackId: string) => {
      const on = !favorites.has(trackId);
      if (trackId.startsWith("local:")) setLocalFavorites((f) => (on ? [trackId, ...f] : f.filter((x) => x !== trackId)));
      else void attempt(() => library.setFavorite(trackId, on));
    },
    setWeighted,
    addLocalTracks: (tracks: Track[]) => {
      const keep = tracks.filter(isPersistable);
      const temp = tracks.filter((t) => !isPersistable(t));
      setStored((s) => [...s, ...keep.filter((t) => !s.some((x) => x.id === t.id))]);
      setSessionTracks((s) => [...s, ...temp]);
    },
    updateLocalTracks: (tracks: Track[]) => {
      const byId = new Map(tracks.map((t) => [t.id, t]));
      const swap = (s: Track[]) => (s.some((t) => byId.has(t.id)) ? s.map((t) => byId.get(t.id) ?? t) : s);
      setStored(swap);
      setSessionTracks(swap);
      setQueue(swap);
    },
    rippedCds: ripped.cds,
    addRippedCd: (key: string) => setRipped((r) => ({ ...r, cds: [{ key, at: Date.now() }, ...r.cds.filter((c) => c.key !== key)] })),
    removeRippedCd: (key: string) => setRipped((r) => ({ ...r, cds: r.cds.filter((c) => c.key !== key) })),
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

/** Files from this computer that were rated 5 stars before songs had favorites. */
function fiveStarLocal(): string[] {
  try {
    const old = JSON.parse(localStorage.getItem("mc.ratings") ?? "{}") as Record<string, number>;
    return Object.entries(old).filter(([id, stars]) => id.startsWith("local:") && stars === 5).map(([id]) => id);
  } catch {
    return [];
  }
}
