/**
 * Your library, saved to your account: albums in your crate, physical media,
 * playlists, artists you follow, your star ratings and your display name.
 * (Server tables: supabase/004_crates_and_ratings.sql. All private to you,
 * except display names; ratings are shared only as averages.)
 *
 * Without an account these are empty, and trying to save something asks the
 * person to sign up (see needsAccount).
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useAuth } from "./auth";
import { useCatalog } from "./catalog";
import { supabase } from "./supabase";
import type { PhysicalFormat, Rating } from "./types";

export interface SavedAlbum { releaseId: string; addedAt: string }
export interface PhysicalItem { id: string; format: PhysicalFormat; releaseId?: string; artistName: string; title: string; note: string; addedAt: string }
export interface Playlist { id: string; name: string; trackIds: string[]; updatedAt: string }
export interface NewPhysical { format: PhysicalFormat; releaseId?: string; artistName?: string; title?: string; note?: string }

export const FORMAT_LABEL: Record<PhysicalFormat, string> = { LP: "Vinyl LP", "7in": '7" single', Cassette: "Cassette", CD: "CD" };

interface Library {
  signedIn: boolean;
  ready: boolean;
  saved: SavedAlbum[];
  physical: PhysicalItem[];
  playlists: Playlist[];
  following: string[];
  myRatings: Record<string, Rating>;
  displayName?: string;
  isSaved: (releaseId: string) => boolean;
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
  rate: (trackId: string, stars: Rating) => Promise<void>;
  setDisplayName: (name: string) => Promise<void>;
  /** Set when someone without an account tries to save something; the app shows a prompt. */
  needsAccount: string | null;
  dismissNeedsAccount: () => void;
}

const LibraryContext = createContext<Library | null>(null);

const SETUP_HINT = "the server needs a one-time update: run supabase/004_crates_and_ratings.sql in the Supabase SQL Editor.";
const check = (error: { message: string } | null) => {
  if (!error) return;
  throw new Error(/relation|does not exist|schema cache/i.test(error.message) ? SETUP_HINT : error.message);
};

export function LibraryProvider({ children }: { children: ReactNode }) {
  const { userId } = useAuth();
  const catalog = useCatalog();
  const [ready, setReady] = useState(false);
  const [saved, setSaved] = useState<SavedAlbum[]>([]);
  const [physical, setPhysical] = useState<PhysicalItem[]>([]);
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [following, setFollowing] = useState<string[]>([]);
  const [myRatings, setMyRatings] = useState<Record<string, Rating>>({});
  const [displayName, setDisplayNameState] = useState<string>();
  const [needsAccount, setNeedsAccount] = useState<string | null>(null);

  useEffect(() => {
    setSaved([]); setPhysical([]); setPlaylists([]); setFollowing([]); setMyRatings({}); setDisplayNameState(undefined);
    if (!userId) { setReady(true); return; }
    setReady(false);
    let live = true;
    Promise.all([
      supabase.from("crate_items").select("*").order("added_at", { ascending: false }),
      supabase.from("physical_items").select("*").order("added_at", { ascending: false }),
      supabase.from("playlists").select("*").order("updated_at", { ascending: false }),
      supabase.from("follows").select("*").order("created_at", { ascending: false }),
      supabase.from("ratings").select("track_id,stars"),
      supabase.from("profiles").select("display_name").eq("user_id", userId).maybeSingle(),
    ]).then(([c, ph, pl, f, r, pr]) => {
      if (!live) return;
      setSaved((c.data ?? []).map((x) => ({ releaseId: x.release_id, addedAt: x.added_at })));
      setPhysical((ph.data ?? []).map(physicalFromRow));
      setPlaylists((pl.data ?? []).map(playlistFromRow));
      setFollowing((f.data ?? []).map((x) => x.artist_id));
      setMyRatings(Object.fromEntries((r.data ?? []).map((x) => [x.track_id, x.stars as Rating])));
      setDisplayNameState(pr.data?.display_name ?? undefined);
      setReady(true);
    });
    return () => { live = false; };
  }, [userId]);

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
  }, [gate, saved]);

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
    const before = playlists;
    const now = new Date().toISOString();
    setPlaylists((ps) => ps.map((p) => (p.id === id ? { ...p, ...(patch.name !== undefined ? { name: patch.name } : {}), ...(patch.track_ids ? { trackIds: patch.track_ids } : {}), updatedAt: now } : p)));
    const { error } = await supabase.from("playlists").update({ ...patch, updated_at: now }).eq("id", id);
    if (error) setPlaylists(before);
    check(error);
  }, [playlists]);

  const createPlaylist = useCallback(async (name: string, trackIds: string[] = []) => {
    gate("make playlists");
    const { data, error } = await supabase.from("playlists").insert({ name: name.trim() || "New playlist", track_ids: trackIds }).select().single();
    check(error);
    const p = playlistFromRow(data);
    setPlaylists((ps) => [p, ...ps]);
    return p;
  }, [gate]);

  const renamePlaylist = useCallback(async (id: string, name: string) => { gate("edit playlists"); await writePlaylist(id, { name: name.trim() || "Untitled playlist" }); }, [gate, writePlaylist]);
  const addToPlaylist = useCallback(async (id: string, trackIds: string[]) => {
    gate("add to playlists");
    const p = playlists.find((x) => x.id === id);
    if (p) await writePlaylist(id, { track_ids: [...p.trackIds, ...trackIds] });
  }, [gate, playlists, writePlaylist]);
  const removeFromPlaylist = useCallback(async (id: string, index: number) => {
    gate("edit playlists");
    const p = playlists.find((x) => x.id === id);
    if (p) await writePlaylist(id, { track_ids: p.trackIds.filter((_, i) => i !== index) });
  }, [gate, playlists, writePlaylist]);
  const deletePlaylist = useCallback(async (id: string) => {
    gate("edit playlists");
    const before = playlists;
    setPlaylists((ps) => ps.filter((p) => p.id !== id));
    const { error } = await supabase.from("playlists").delete().eq("id", id);
    if (error) setPlaylists(before);
    check(error);
  }, [gate, playlists]);

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

  const rate = useCallback(async (trackId: string, stars: Rating) => {
    gate("rate songs");
    const before = myRatings[trackId];
    setMyRatings((r) => {
      const next = { ...r };
      if (stars) next[trackId] = stars; else delete next[trackId];
      return next;
    });
    const { error } = stars
      ? await supabase.from("ratings").upsert({ track_id: trackId, stars, updated_at: new Date().toISOString() }, { onConflict: "user_id,track_id" })
      : await supabase.from("ratings").delete().eq("track_id", trackId);
    if (error) setMyRatings((r) => ({ ...r, [trackId]: before }));
    check(error);
    catalog.refreshAverages();
  }, [gate, myRatings, catalog]);

  const setDisplayName = useCallback(async (name: string) => {
    const uid = gate("choose a display name");
    const { error } = await supabase.from("profiles").upsert({ user_id: uid, display_name: name.trim(), updated_at: new Date().toISOString() });
    check(error);
    setDisplayNameState(name.trim());
  }, [gate]);

  const value = useMemo<Library>(() => ({
    signedIn: !!userId, ready, saved, physical, playlists, following, myRatings, displayName,
    isSaved: (id) => saved.some((s) => s.releaseId === id),
    isFollowing: (id) => following.includes(id),
    save, unsave, addPhysical, removePhysical, createPlaylist, renamePlaylist, deletePlaylist, addToPlaylist, removeFromPlaylist,
    follow, unfollow, rate, setDisplayName,
    needsAccount, dismissNeedsAccount: () => setNeedsAccount(null),
  }), [userId, ready, saved, physical, playlists, following, myRatings, displayName, save, unsave, addPhysical, removePhysical, createPlaylist, renamePlaylist, deletePlaylist, addToPlaylist, removeFromPlaylist, follow, unfollow, rate, setDisplayName, needsAccount]);

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
  return { id: String(r.id), name: String(r.name ?? ""), trackIds: (r.track_ids as string[]) ?? [], updatedAt: String(r.updated_at ?? "") };
}

export function useLibrary() {
  const ctx = useContext(LibraryContext);
  if (!ctx) throw new Error("useLibrary must be used inside <LibraryProvider>");
  return ctx;
}
