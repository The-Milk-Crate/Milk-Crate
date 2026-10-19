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
import { fromPortable, isSongKey, toPortable, useComputerSongsVersion } from "./songKeys";
import type { PhysicalFormat, Rating } from "./types";

export interface SavedAlbum { releaseId: string; addedAt: string }
/** A song added to your crate on its own (not with its whole release). */
export interface CrateSong { trackId: string; addedAt: string }
export interface PhysicalItem { id: string; format: PhysicalFormat; releaseId?: string; artistName: string; title: string; note: string; addedAt: string }
/**
 * A playlist. `trackIds` is its songs in order, including songs from your computers: "local:…" for
 * this computer's copy (e.g. a ripped CD), "song:…" for one this computer doesn't have. The music
 * never leaves your computers; only a description of each song is kept with the playlist (see songKeys.ts).
 * `localCount` is how many play here, `missingCount` how many aren't on this computer.
 */
export interface Playlist {
  id: string; name: string; trackIds: string[]; updatedAt: string; localCount: number; missingCount: number;
  /** The full order as saved with your account when it has songs from your computers (described), else none. */
  songOrder?: string[];
  /** The picture you chose, kept with your account ("<user>/<playlist>.jpg?v=…"); none: Milk Crate makes one. */
  coverPath?: string;
}

/** Where playlist pictures are kept (a private bucket: only you can read yours). See supabase/012_playlist_pictures.sql. */
export const PLAYLIST_PICTURES = "playlist-pictures";

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
  /** Saves a picture for a playlist with your account (any computer shows it), or removes it (null). */
  setPlaylistPicture: (id: string, picture: Blob | null) => Promise<void>;
  addToPlaylist: (id: string, trackIds: string[]) => Promise<void>;
  removeFromPlaylist: (id: string, index: number) => Promise<void>;
  follow: (artistId: string) => Promise<void>;
  unfollow: (artistId: string) => Promise<void>;
  isFavorite: (trackId: string) => boolean;
  /** Favorite songs from your computers, described (see songKeys.ts); null while the server doesn't keep them (013 not run). */
  computerFavorites: string[] | null;
  /** Favorites songs from your computers (by description), or takes them out. */
  setComputerFavorite: (keys: string[], on: boolean) => Promise<void>;
  /** A song from your computers got new details (e.g. a ripped CD's titles were edited): its playlists and favorites follow (old description → new). */
  renameSongKeys: (map: Record<string, string>) => Promise<void>;
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
const SETUP_HINT_013 = "the server needs a one-time update: run supabase/013_computer_songs.sql in the Supabase SQL Editor.";
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
  // Where this computer's songs sit in each playlist (see mergePlaylistOrder), from before playlists
  // kept that with your account (supabase/013_computer_songs.sql), and while the server doesn't have it yet.
  const [localOrder, setLocalOrder] = usePersistentState<Record<string, string[]>>("mc.playlistOrder", {});
  const songsVersion = useComputerSongsVersion();
  const playlists = useMemo(() => serverPlaylists.map((p) => {
    const trackIds = mergePlaylistOrder(p.songOrder ?? localOrder[p.id], p.trackIds).map(fromPortable);
    return { ...p, trackIds, localCount: trackIds.filter((id) => id.startsWith("local:")).length, missingCount: trackIds.filter(isSongKey).length };
  }), [serverPlaylists, localOrder, songsVersion]); // eslint-disable-line react-hooks/exhaustive-deps
  const rememberOrder = useCallback((id: string, all: string[] | null) => setLocalOrder((o) => {
    const next = { ...o };
    if (all && all.some(isLocalTrackId)) next[id] = all;
    else delete next[id];
    return next;
  }), [setLocalOrder]);
  const [following, setFollowing] = useState<string[]>([]);
  const [favorites, setFavorites] = useState<string[]>([]);
  // Favorite songs from your computers, described (null: the server doesn't keep them yet, see 013).
  const [computerFavorites, setComputerFavorites] = useState<string[] | null>(null);
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
    if (fresh) { setSaved([]); setCrateSongs([]); setPhysical([]); setPlaylists([]); setFollowing([]); setFavorites([]); setComputerFavorites(null); setAlbumRatings({}); setDisplayNameState(undefined); }
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
      supabase.from("computer_favorites").select("song_key").order("created_at", { ascending: false }),
    ]).then(([c, ph, pl, f, fav, ar, pr, cs, cf]) => {
      if (!live) return;
      // A refresh that failed (offline) keeps what's already here.
      if (!fresh && [c, ph, pl, f, fav, ar, cs].some((x) => x.error)) return;
      setSaved((c.data ?? []).map((x) => ({ releaseId: x.release_id, addedAt: x.added_at })));
      setCrateSongs((cs.data ?? []).map((x) => ({ trackId: x.track_id as string, addedAt: x.added_at as string })));
      setPhysical((ph.data ?? []).map(physicalFromRow));
      setPlaylists((pl.data ?? []).map(playlistFromRow));
      setFollowing((f.data ?? []).map((x) => x.artist_id));
      setFavorites((fav.data ?? []).map((x) => x.track_id as string));
      if (!cf.error) setComputerFavorites((cf.data ?? []).map((x) => x.song_key as string));
      else if (fresh) setComputerFavorites(null);
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

  // False once the server turns out not to keep playlists' full order yet (013 not run).
  const songOrderOk = useRef(true);
  const writePlaylist = useCallback(async (id: string, patch: { name?: string; track_ids?: string[]; song_order?: string[] | null }) => {
    const before = serverPlaylists;
    const now = new Date().toISOString();
    if (!songOrderOk.current) delete patch.song_order;
    setPlaylists((ps) => ps.map((p) => (p.id === id ? {
      ...p, ...(patch.name !== undefined ? { name: patch.name } : {}), ...(patch.track_ids ? { trackIds: patch.track_ids } : {}),
      ...(patch.song_order !== undefined ? { songOrder: patch.song_order ?? undefined } : {}), updatedAt: now,
    } : p)));
    let { error } = await supabase.from("playlists").update({ ...patch, updated_at: now }).eq("id", id);
    if (error && "song_order" in patch && /song_order/.test(error.message)) {
      songOrderOk.current = false;
      const { song_order: _skip, ...rest } = patch; // eslint-disable-line @typescript-eslint/no-unused-vars
      ({ error } = await supabase.from("playlists").update({ ...rest, updated_at: now }).eq("id", id));
    }
    if (error) setPlaylists(before);
    check(error);
  }, [serverPlaylists]);

  /** What's saved with your account for a playlist's full order: catalog songs by id, and the full order described when it has songs from your computers. */
  const orderRow = (all: string[]) => {
    const described = all.map(toPortable).filter((t) => !t.startsWith("local:")); // a file only this session knows can't be described
    return { track_ids: all.filter((t) => !isLocalTrackId(t)), song_order: described.some(isSongKey) ? described : null };
  };

  /** Saves a playlist's full order, with your account (and on this computer, until the server keeps it). */
  const writeOrder = useCallback(async (id: string, all: string[]) => {
    rememberOrder(id, all);
    await writePlaylist(id, orderRow(all));
  }, [rememberOrder, writePlaylist]);

  // Playlists whose computer songs were only remembered on this computer: saved with your account once.
  const sentOrder = useRef(new Set<string>());
  useEffect(() => {
    if (!ready || !userId || !songOrderOk.current) return;
    for (const p of serverPlaylists) {
      const mine = localOrder[p.id];
      if (p.songOrder || !mine || sentOrder.current.has(p.id)) continue;
      // Wait until this computer's songs are known (they're described from their tags).
      if (mine.some((t) => t.startsWith("local:") && toPortable(t) === t)) continue;
      sentOrder.current.add(p.id);
      void writePlaylist(p.id, orderRow(mergePlaylistOrder(mine, p.trackIds))).catch(() => {});
    }
  }, [ready, userId, serverPlaylists, localOrder, songsVersion, writePlaylist]); // eslint-disable-line react-hooks/exhaustive-deps

  const createPlaylist = useCallback(async (name: string, trackIds: string[] = []) => {
    gate("make playlists");
    const row = { name: name.trim() || "New playlist", ...orderRow(trackIds) };
    let { data, error } = await supabase.from("playlists").insert(row).select().single();
    if (error && /song_order/.test(error.message)) {
      songOrderOk.current = false;
      ({ data, error } = await supabase.from("playlists").insert({ name: row.name, track_ids: row.track_ids }).select().single());
    }
    check(error);
    const p = playlistFromRow(data);
    setPlaylists((ps) => [p, ...ps]);
    rememberOrder(p.id, trackIds);
    return { ...p, trackIds, localCount: trackIds.filter((t) => t.startsWith("local:")).length, missingCount: 0 };
  }, [gate, rememberOrder]); // eslint-disable-line react-hooks/exhaustive-deps

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
    // Its picture goes too.
    const path = before.find((p) => p.id === id)?.coverPath?.split("?")[0];
    if (path) void supabase.storage.from(PLAYLIST_PICTURES).remove([path]);
  }, [gate, serverPlaylists, rememberOrder]);

  const setPlaylistPicture = useCallback(async (id: string, picture: Blob | null) => {
    const uid = gate("edit playlists");
    const path = `${uid}/${id}.jpg`;
    if (picture) {
      const { error } = await supabase.storage.from(PLAYLIST_PICTURES).upload(path, picture, { contentType: picture.type || "image/jpeg", upsert: true });
      check(error);
    } else {
      await supabase.storage.from(PLAYLIST_PICTURES).remove([path]);
    }
    // A new version each time, so every computer shows the new picture rather than the old one.
    const coverPath = picture ? `${path}?v=${Date.now()}` : null;
    const now = new Date().toISOString();
    const { error } = await supabase.from("playlists").update({ cover_path: coverPath, updated_at: now }).eq("id", id);
    check(error);
    setPlaylists((ps) => ps.map((p) => (p.id === id ? { ...p, coverPath: coverPath ?? undefined, updatedAt: now } : p)));
  }, [gate]);

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

  /** Favorites songs from your computers (described: see songKeys.ts), or takes them out. */
  const setComputerFavorite = useCallback(async (keys: string[], on: boolean) => {
    gate("favorite songs");
    if (!keys.length) return;
    const before = computerFavorites;
    setComputerFavorites((f) => {
      const rest = (f ?? []).filter((x) => !keys.includes(x));
      return on ? [...keys, ...rest] : rest;
    });
    const { error } = on
      ? await supabase.from("computer_favorites").upsert(keys.map((song_key) => ({ song_key })), { onConflict: "user_id,song_key", ignoreDuplicates: true })
      : await supabase.from("computer_favorites").delete().in("song_key", keys);
    if (error) setComputerFavorites(before);
    check(error, SETUP_HINT_013);
  }, [gate, computerFavorites]);

  const renameSongKeys = useCallback(async (map: Record<string, string>) => {
    if (!userId) return;
    const olds = Object.keys(map).filter((k) => map[k] && map[k] !== k);
    if (!olds.length) return;
    const hit = (computerFavorites ?? []).filter((k) => olds.includes(k));
    if (hit.length) {
      await setComputerFavorite(hit.map((k) => map[k]), true).catch(() => {});
      await setComputerFavorite(hit, false).catch(() => {});
    }
    for (const p of serverPlaylists) {
      if (p.songOrder?.some((k) => olds.includes(k))) {
        await writePlaylist(p.id, { song_order: p.songOrder.map((k) => map[k] ?? k) }).catch(() => {});
      }
    }
  }, [userId, computerFavorites, setComputerFavorite, serverPlaylists, writePlaylist]);

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
    signedIn: !!userId, ready, saved, physical, playlists, following, favorites, computerFavorites, setComputerFavorite, renameSongKeys, albumRatings, displayName,
    isFavorite: (trackId: string) => favoriteSet.has(trackId),
    isSaved: (id) => saved.some((s) => s.releaseId === id),
    isSongInCrate: (trackId, releaseId) => saved.some((s) => s.releaseId === releaseId) || crateSongs.some((x) => x.trackId === trackId),
    addSongs, removeSongs, crateSongs,
    isFollowing: (id) => following.includes(id),
    save, unsave, addPhysical, removePhysical, createPlaylist, renamePlaylist, deletePlaylist, setPlaylistPicture, addToPlaylist, removeFromPlaylist,
    follow, unfollow, setFavorite, rateAlbum, setDisplayName,
    needsAccount, dismissNeedsAccount: () => setNeedsAccount(null),
  }), [userId, ready, saved, physical, playlists, following, crateSongs, addSongs, removeSongs, favorites, favoriteSet, computerFavorites, setComputerFavorite, renameSongKeys, albumRatings, displayName, save, unsave, addPhysical, removePhysical, createPlaylist, renamePlaylist, deletePlaylist, setPlaylistPicture, addToPlaylist, removeFromPlaylist, follow, unfollow, setFavorite, rateAlbum, setDisplayName, needsAccount]);

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
  return { id: String(r.id), name: String(r.name ?? ""), trackIds: (r.track_ids as string[]) ?? [], updatedAt: String(r.updated_at ?? ""), localCount: 0, missingCount: 0,
    songOrder: Array.isArray(r.song_order) && r.song_order.length ? (r.song_order as string[]) : undefined,
    coverPath: typeof r.cover_path === "string" && r.cover_path ? r.cover_path : undefined };
}

export function useLibrary() {
  const ctx = useContext(LibraryContext);
  if (!ctx) throw new Error("useLibrary must be used inside <LibraryProvider>");
  return ctx;
}
