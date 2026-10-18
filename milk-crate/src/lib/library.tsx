/**
 * Your library, saved to your account: albums in your crate, physical media,
 * playlists, artists you follow, favorite songs, your album ratings and your
 * display name. (Server tables: supabase/004_crates_and_ratings.sql and
 * 007_albums_favorites_streams.sql. All private to you, except display names;
 * album ratings are shared only as averages.)
 *
 * Without an account these are empty, and trying to save something asks the
 * person to sign up (see needsAccount).
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useAuth } from "./auth";
import { useCatalog } from "./catalog";
import { supabase } from "./supabase";
import { usePersistentState } from "./storage";
import { useLiveRefresh } from "./liveRefresh";
import { isLocalTrackId, mergePlaylistOrder } from "./playlistOrder";
import type { PhysicalFormat, Rating } from "./types";

export interface SavedAlbum { releaseId: string; addedAt: string }
/** A song added to your crate on its own (not with its whole release). */
export interface CrateSong { trackId: string; addedAt: string }
export interface PhysicalItem { id: string; format: PhysicalFormat; releaseId?: string; artistName: string; title: string; note: string; addedAt: string }
/**
 * A playlist. `trackIds` is its songs in order, including songs from this computer (ids "local:…",
 * e.g. a ripped CD) — those are kept on this computer only and never sent to Milk Crate's servers.
 * `localCount` is how many of them there are.
 */
export interface Playlist { id: string; name: string; trackIds: string[]; updatedAt: string; localCount: number }

export { isLocalTrackId, mergePlaylistOrder } from "./playlistOrder";
export interface NewPhysical { format: PhysicalFormat; releaseId?: string; artistName?: string; title?: string; note?: string }

export const FORMAT_LABEL: Record<PhysicalFormat, string> = { LP: "Vinyl LP", "7in": '7" single', Cassette: "Cassette", CD: "CD" };

interface Library {
  signedIn: boolean;
  ready: boolean;
  saved: SavedAlbum[];
  /** Songs added on their own (see lib/crate.ts for how they group into singles and albums). */
  crateSongs: CrateSong[];
  physical: PhysicalItem[];
  playlists: Playlist[];
  following: string[];
  /** Favorite songs, newest first. */
  favorites: string[];
  /** Your star rating for each album you've rated. */
  albumRatings: Record<string, Rating>;
  displayName?: string;
  isSaved: (releaseId: string) => boolean;
  /** Is this song in your crate (on its own, or with its whole release)? */
  isSongInCrate: (trackId: string, releaseId: string) => boolean;
  /** Adds songs to your crate on their own. */
  addSongs: (trackIds: string[]) => Promise<void>;
  /**
   * Takes songs out of your crate. If their whole release was in your crate, the rest of
   * the release stays in as separate songs.
   */
  removeSongs: (trackIds: string[], release?: { id: string; trackIds: string[] }) => Promise<void>;
  isFollowing: (artistId: string) => boolean;
  save: (releaseId: string) => Promise<void>;
  unsave: (releaseId: string) => Promise<void>;
  /** Adds a record, tape or CD. If it's on Milk Crate, the digital album goes in your crate too. */
  addPhysical: (item: NewPhysical) => Promise<void>;
  removePhysical: (id: string) => Promise<void>;
  createPlaylist: (name: string, trackIds?: string[]) => Promise<Playlist>;
  renamePlaylist: (id: string, name: string) => Promise<void>;
  deletePlaylist: (id: string) => Promise<void>;
  addToPlaylist: (id: string, trackIds: string[]) => Promise<void>;
  removeFromPlaylist: (id: string, index: number) => Promise<void>;
  follow: (artistId: string) => Promise<void>;
  unfollow: (artistId: string) => Promise<void>;
  isFavorite: (trackId: string) => boolean;
  /** Adds or removes a song from your favorites. */
  setFavorite: (trackId: string, on: boolean) => Promise<void>;
  /** Rates an album 1–5 stars (0 clears your rating). */
  rateAlbum: (releaseId: string, stars: Rating) => Promise<void>;
  setDisplayName: (name: string) => Promise<void>;
  /** Set when someone without an account tries to save something; the app shows a prompt. */
  needsAccount: string | null;
  dismissNeedsAccount: () => void;
}

const LibraryContext = createContext<Library | null>(null);

const SETUP_HINT = "the server needs a one-time update: run supabase/004_crates_and_ratings.sql in the Supabase SQL Editor.";
const SETUP_HINT_011 = "the server needs a one-time update: run supabase/011_crate_songs.sql in the Supabase SQL Editor.";
const SETUP_HINT_007 = "the server needs a one-time update: run supabase/007_albums_favorites_streams.sql in the Supabase SQL Editor.";
const check = (error: { message: string } | null, hint = SETUP_HINT) => {
  if (!error) return;
  throw new Error(/relation|does not exist|schema cache/i.test(error.message) ? hint : error.message);
};

export function LibraryProvider({ children }: { children: ReactNode }) {
  const { userId, session } = useAuth();
  const nameFromSignUp = typeof session?.user.user_metadata?.display_name === "string" ? (session.user.user_metadata.display_name as string).trim().slice(0, 40) : "";
  const catalog = useCatalog();
  const [ready, setReady] = useState(false);
  const [saved, setSaved] = useState<SavedAlbum[]>([]);
  const [crateSongs, setCrateSongs] = useState<CrateSong[]>([]);
  const [physical, setPhysical] = useState<PhysicalItem[]>([]);
  const [serverPlaylists, setPlaylists] = useState<Playlist[]>([]);
  // Where this computer's songs sit in each playlist (see mergePlaylistOrder). Never leaves this computer.
  const [localOrder, setLocalOrder] = usePersistentState<Record<string, string[]>>("mc.playlistOrder", {});
  const playlists = useMemo(() => serverPlaylists.map((p) => {
    const trackIds = mergePlaylistOrder(localOrder[p.id], p.trackIds);
    return { ...p, trackIds, localCount: trackIds.filter(isLocalTrackId).length };
  }), [serverPlaylists, localOrder]);
  const rememberOrder = useCallback((id: string, all: string[] | null) => setLocalOrder((o) => {
    const next = { ...o };
    if (all && all.some(isLocalTrackId)) next[id] = all;
    else delete next[id];
    return next;
  }), [setLocalOrder]);
  const [following, setFollowing] = useState<string[]>([]);
  const [favorites, setFavorites] = useState<string[]>([]);
  const [albumRatings, setAlbumRatings] = useState<Record<string, Rating>>({});
  const [displayName, setDisplayNameState] = useState<string>();
  const [needsAccount, setNeedsAccount] = useState<string | null>(null);

  // Reloaded now and then while the app is open, so changes made on your other computers show up.
  const [tick, setTick] = useState(0);
  useLiveRefresh(() => setTick((t) => t + 1));
  const loadedFor = useRef<string | undefined>(undefined);
  useEffect(() => {
    const fresh = loadedFor.current !== (userId ?? "");
    loadedFor.current = userId ?? "";
    if (fresh) { setSaved([]); setCrateSongs([]); setPhysical([]); setPlaylists([]); setFollowing([]); setFavorites([]); setAlbumRatings({}); setDisplayNameState(undefined); }
    if (!userId) { setReady(true); return; }
    if (fresh) setReady(false);
    let live = true;
    Promise.all([
      supabase.from("crate_items").select("*").order("added_at", { ascending: false }),
      supabase.from("physical_items").select("*").order("added_at", { ascending: false }),
      supabase.from("playlists").select("*").order("updated_at", { ascending: false }),
      supabase.from("follows").select("*").order("created_at", { ascending: false }),
      supabase.from("favorites").select("track_id").order("created_at", { ascending: false }),
      supabase.from("album_ratings").select("release_id,stars"),
      supabase.from("profiles").select("display_name").eq("user_id", userId).maybeSingle(),
      supabase.from("crate_songs").select("track_id,added_at").order("added_at", { ascending: false }),
    ]).then(([c, ph, pl, f, fav, ar, pr, cs]) => {
      if (!live) return;
      // A refresh that failed (offline) keeps what's already here.
      if (!fresh && [c, ph, pl, f, fav, ar, cs].some((x) => x.error)) return;
      setSaved((c.data ?? []).map((x) => ({ releaseId: x.release_id, addedAt: x.added_at })));
      setCrateSongs((cs.data ?? []).map((x) => ({ trackId: x.track_id as string, addedAt: x.added_at as string })));
      setPhysical((ph.data ?? []).map(physicalFromRow));
      setPlaylists((pl.data ?? []).map(playlistFromRow));
      setFollowing((f.data ?? []).map((x) => x.artist_id));
      setFavorites((fav.data ?? []).map((x) => x.track_id as string));
      setAlbumRatings(Object.fromEntries((ar.data ?? []).map((x) => [x.release_id, x.stars as Rating])));
      setDisplayNameState(pr.data?.display_name ?? undefined);
      // The name chosen when signing up becomes the display name the first time the account signs in.
      if (!pr.error && !pr.data && nameFromSignUp) {
        void supabase.from("profiles").upsert({ user_id: userId, display_name: nameFromSignUp, updated_at: new Date().toISOString() })
          .then(({ error }) => !error && live && setDisplayNameState(nameFromSignUp));
      }
      setReady(true);
    });
    return () => { live = false; };
  }, [userId, tick]); // eslint-disable-line react-hooks/exhaustive-deps

  const gate = useCallback((what: string) => {
    if (!userId) {
      setNeedsAccount(what);
      throw new Error("NEEDS_ACCOUNT");
    }
    return userId;
  }, [userId]);

  const save = useCallback(async (releaseId: string) => {
    gate("save albums to your crate");
    if (saved.some((s) => s.releaseId === releaseId)) return;
    const item = { releaseId, addedAt: new Date().toISOString() };
    setSaved((s) => [item, ...s]);
    const { error } = await supabase.from("crate_items").upsert({ release_id: releaseId }, { onConflict: "user_id,release_id" });
    if (error) setSaved((s) => s.filter((x) => x.releaseId !== releaseId));
    check(error);
  }, [gate, saved]);

  const unsave = useCallback(async (releaseId: string) => {
    gate("manage your crate");
    const before = saved;
    setSaved((s) => s.filter((x) => x.releaseId !== releaseId));
    const { error } = await supabase.from("crate_items").delete().eq("release_id", releaseId);
    if (error) setSaved(before);
    check(error);
    // Songs from it that were added on their own go too.
    const songs = catalog.releaseById[releaseId]?.trackIds ?? [];
    const loose = crateSongs.filter((x) => songs.includes(x.trackId)).map((x) => x.trackId);
    if (loose.length) {
      setCrateSongs((cs) => cs.filter((x) => !loose.includes(x.trackId)));
      await supabase.from("crate_songs").delete().in("track_id", loose);
    }
  }, [gate, saved, crateSongs, catalog.releaseById]);

  const addSongs = useCallback(async (trackIds: string[]) => {
    gate("add songs to your crate");
    const fresh = trackIds.filter((id) => !crateSongs.some((x) => x.trackId === id));
    if (!fresh.length) return;
    const now = new Date().toISOString();
    setCrateSongs((cs) => [...fresh.map((trackId) => ({ trackId, addedAt: now })), ...cs]);
    const { error } = await supabase.from("crate_songs").upsert(fresh.map((track_id) => ({ track_id })), { onConflict: "user_id,track_id", ignoreDuplicates: true });
    if (error) setCrateSongs((cs) => cs.filter((x) => !fresh.includes(x.trackId)));
    check(error, SETUP_HINT_011);
  }, [gate, crateSongs]);

  const removeSongs = useCallback(async (trackIds: string[], release?: { id: string; trackIds: string[] }) => {
    gate("manage your crate");
    // The whole release was in: keep the rest of it, as separate songs.
    if (release && saved.some((x) => x.releaseId === release.id)) {
      const rest = release.trackIds.filter((id) => !trackIds.includes(id));
      if (rest.length) await addSongs(rest);
      const before = saved;
      setSaved((s) => s.filter((x) => x.releaseId !== release.id));
      const { error } = await supabase.from("crate_items").delete().eq("release_id", release.id);
      if (error) setSaved(before);
      check(error);
    }
    const before = crateSongs;
    setCrateSongs((cs) => cs.filter((x) => !trackIds.includes(x.trackId)));
    const { error } = await supabase.from("crate_songs").delete().in("track_id", trackIds);
    if (error) setCrateSongs(before);
    check(error, SETUP_HINT_011);
  }, [gate, saved, crateSongs, addSongs]);

  const addPhysical = useCallback(async (item: NewPhysical) => {
    gate("add records, tapes and CDs to your crate");
    const row = { format: item.format, release_id: item.releaseId ?? null, artist_name: item.artistName ?? "", title: item.title ?? "", note: item.note ?? "" };
    const { data, error } = await supabase.from("physical_items").insert(row).select().single();
    check(error);
    setPhysical((p) => [physicalFromRow(data), ...p]);
    if (item.releaseId) await save(item.releaseId);
  }, [gate, save]);

  const removePhysical = useCallback(async (id: string) => {
    gate("manage your crate");
    const before = physical;
    setPhysical((p) => p.filter((x) => x.id !== id));
    const { error } = await supabase.from("physical_items").delete().eq("id", id);
    if (error) setPhysical(before);
    check(error);
  }, [gate, physical]);

  const writePlaylist = useCallback(async (id: string, patch: { name?: string; track_ids?: string[] }) => {
    const before = serverPlaylists;
    const now = new Date().toISOString();
    setPlaylists((ps) => ps.map((p) => (p.id === id ? { ...p, ...(patch.name !== undefined ? { name: patch.name } : {}), ...(patch.track_ids ? { trackIds: patch.track_ids } : {}), updatedAt: now } : p)));
    const { error } = await supabase.from("playlists").update({ ...patch, updated_at: now }).eq("id", id);
    if (error) setPlaylists(before);
    check(error);
  }, [serverPlaylists]);

  /** Saves a playlist's full order: catalog songs to your account, this computer's songs here only. */
  const writeOrder = useCallback(async (id: string, all: string[]) => {
    rememberOrder(id, all);
    await writePlaylist(id, { track_ids: all.filter((t) => !isLocalTrackId(t)) });
  }, [rememberOrder, writePlaylist]);

  const createPlaylist = useCallback(async (name: string, trackIds: string[] = []) => {
    gate("make playlists");
    const { data, error } = await supabase.from("playlists")
      .insert({ name: name.trim() || "New playlist", track_ids: trackIds.filter((t) => !isLocalTrackId(t)) }).select().single();
    check(error);
    const p = playlistFromRow(data);
    setPlaylists((ps) => [p, ...ps]);
    rememberOrder(p.id, trackIds);
    return { ...p, trackIds, localCount: trackIds.filter(isLocalTrackId).length };
  }, [gate, rememberOrder]);

  const renamePlaylist = useCallback(async (id: string, name: string) => { gate("edit playlists"); await writePlaylist(id, { name: name.trim() || "Untitled playlist" }); }, [gate, writePlaylist]);
  const addToPlaylist = useCallback(async (id: string, trackIds: string[]) => {
    gate("add to playlists");
    const p = playlists.find((x) => x.id === id);
    if (p) await writeOrder(id, [...p.trackIds, ...trackIds]);
  }, [gate, playlists, writeOrder]);
  const removeFromPlaylist = useCallback(async (id: string, index: number) => {
    gate("edit playlists");
    const p = playlists.find((x) => x.id === id);
    if (p) await writeOrder(id, p.trackIds.filter((_, i) => i !== index));
  }, [gate, playlists, writeOrder]);
  const deletePlaylist = useCallback(async (id: string) => {
    gate("edit playlists");
    rememberOrder(id, null);
    const before = serverPlaylists;
    setPlaylists((ps) => ps.filter((p) => p.id !== id));
    const { error } = await supabase.from("playlists").delete().eq("id", id);
    if (error) setPlaylists(before);
    check(error);
  }, [gate, serverPlaylists, rememberOrder]);

  const follow = useCallback(async (artistId: string) => {
    gate("follow artists");
    if (following.includes(artistId)) return;
    setFollowing((f) => [artistId, ...f]);
    const { error } = await supabase.from("follows").upsert({ artist_id: artistId }, { onConflict: "user_id,artist_id" });
    if (error) setFollowing((f) => f.filter((x) => x !== artistId));
    check(error);
  }, [gate, following]);

  const unfollow = useCallback(async (artistId: string) => {
    gate("follow artists");
    setFollowing((f) => f.filter((x) => x !== artistId));
    const { error } = await supabase.from("follows").delete().eq("artist_id", artistId);
    if (error) setFollowing((f) => [artistId, ...f]);
    check(error);
  }, [gate]);

  const setFavorite = useCallback(async (trackId: string, on: boolean) => {
    gate("favorite songs");
    const before = favorites;
    setFavorites((f) => (on ? [trackId, ...f.filter((x) => x !== trackId)] : f.filter((x) => x !== trackId)));
    const { error } = on
      ? await supabase.from("favorites").upsert({ track_id: trackId }, { onConflict: "user_id,track_id", ignoreDuplicates: true })
      : await supabase.from("favorites").delete().eq("track_id", trackId);
    if (error) setFavorites(before);
    check(error, SETUP_HINT_007);
  }, [gate, favorites]);

  const rateAlbum = useCallback(async (releaseId: string, stars: Rating) => {
    gate("rate albums");
    const before = albumRatings[releaseId];
    setAlbumRatings((r) => {
      const next = { ...r };
      if (stars) next[releaseId] = stars; else delete next[releaseId];
      return next;
    });
    const { error } = stars
      ? await supabase.from("album_ratings").upsert({ release_id: releaseId, stars, updated_at: new Date().toISOString() }, { onConflict: "user_id,release_id" })
      : await supabase.from("album_ratings").delete().eq("release_id", releaseId);
    if (error) setAlbumRatings((r) => ({ ...r, [releaseId]: before }));
    check(error, SETUP_HINT_007);
    catalog.refreshStats();
  }, [gate, albumRatings, catalog]);

  const setDisplayName = useCallback(async (name: string) => {
    const uid = gate("choose a display name");
    const { error } = await supabase.from("profiles").upsert({ user_id: uid, display_name: name.trim(), updated_at: new Date().toISOString() });
    check(error);
    setDisplayNameState(name.trim());
  }, [gate]);

  const favoriteSet = useMemo(() => new Set(favorites), [favorites]);
  const value = useMemo<Library>(() => ({
    signedIn: !!userId, ready, saved, physical, playlists, following, favorites, albumRatings, displayName,
    isFavorite: (trackId: string) => favoriteSet.has(trackId),
    isSaved: (id) => saved.some((s) => s.releaseId === id),
    isSongInCrate: (trackId, releaseId) => saved.some((s) => s.releaseId === releaseId) || crateSongs.some((x) => x.trackId === trackId),
    addSongs, removeSongs, crateSongs,
    isFollowing: (id) => following.includes(id),
    save, unsave, addPhysical, removePhysical, createPlaylist, renamePlaylist, deletePlaylist, addToPlaylist, removeFromPlaylist,
    follow, unfollow, setFavorite, rateAlbum, setDisplayName,
    needsAccount, dismissNeedsAccount: () => setNeedsAccount(null),
  }), [userId, ready, saved, physical, playlists, following, crateSongs, addSongs, removeSongs, favorites, favoriteSet, albumRatings, displayName, save, unsave, addPhysical, removePhysical, createPlaylist, renamePlaylist, deletePlaylist, addToPlaylist, removeFromPlaylist, follow, unfollow, setFavorite, rateAlbum, setDisplayName, needsAccount]);

  return <LibraryContext.Provider value={value}>{children}</LibraryContext.Provider>;
}

/** Runs a library action, ignoring the "needs an account" case (the app already shows the prompt). */
export async function attempt(action: () => Promise<unknown>, onError?: (message: string) => void) {
  try {
    await action();
  } catch (e) {
    const msg = (e as Error).message;
    if (msg !== "NEEDS_ACCOUNT") onError?.(msg);
  }
}

function physicalFromRow(r: Record<string, unknown>): PhysicalItem {
  return {
    id: String(r.id), format: r.format as PhysicalFormat, releaseId: (r.release_id as string) ?? undefined,
    artistName: String(r.artist_name ?? ""), title: String(r.title ?? ""), note: String(r.note ?? ""), addedAt: String(r.added_at ?? ""),
  };
}
function playlistFromRow(r: Record<string, unknown>): Playlist {
  return { id: String(r.id), name: String(r.name ?? ""), trackIds: (r.track_ids as string[]) ?? [], updatedAt: String(r.updated_at ?? ""), localCount: 0 };
}

export function useLibrary() {
  const ctx = useContext(LibraryContext);
  if (!ctx) throw new Error("useLibrary must be used inside <LibraryProvider>");
  return ctx;
}
