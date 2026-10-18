/**
 * The catalog every screen reads from: artists, releases and tracks on the
 * Milk Crate server (Supabase).
 *
 * Artist accounts apply on "For artists"; once a reviewer approves them,
 * their releases go to Supabase Storage and show up for every listener.
 * Only approved artists appear on public screens (the server enforces this
 * too). An artist always sees their own profile, approved or not.
 */
import { useLiveRefresh } from "./liveRefresh";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { byId } from "./format";
import { load, save } from "./storage";
import { useAuth } from "./auth";
import { prepareAudio, type AudioFile } from "./transcode";
import { measureSound } from "./measure";
import type { SoundProfile } from "./sound";
import { MAX_UPLOAD_MB } from "../config";
import { isServerFile, profilesPath } from "./artistPage";
import { artistFromRow, fileSlug, readLocalFile, releasesFromRows, supabase, type ArtistRow, type ReleaseRow, type TrackRow } from "./supabase";
import { isUpcoming, type Artist, type ArtistPage, type Release, type Track } from "./types";

export type CatalogStatus = "loading" | "ready" | "offline";

export interface NewRelease {
  title: string;
  kind: Release["kind"];
  year: number;
  /** A local URL for the cover (desktop asset URL or browser blob URL), if any. */
  art?: string;
  /** When it comes out (ISO). Missing = right away. */
  releaseAt?: string;
}
export interface NewTrack {
  title: string;
  duration: number;
  /** A local URL for the audio file. */
  src: string;
}
export type ProfileInput = Omit<Artist, "id" | "ownerId" | "page" | "status">;

/** Changes to a published release. */
export interface ReleaseEdit {
  title: string;
  kind: Release["kind"];
  year: number;
  /** A new cover (local file URL), null to remove the cover, or undefined to keep it. */
  art?: string | null;
  /** When it comes out (ISO), or null for "out now". */
  releaseAt: string | null;
}
/**
 * A song in an edited release, in its new order. `id` = a song that's already
 * published (keeps its streams, favorites and history). `src` = a new audio
 * file: for a new song, or to replace an existing song's audio.
 */
export interface EditTrack { id?: string; title: string; duration: number; src?: string; lyrics?: string; credits?: string }

/** What an artist tells reviewers when applying. */
export interface Application {
  artistId: string;
  links: string;
  note: string;
  contactEmail?: string;
  reviewNote?: string;
  submittedAt: string;
}
/** A reviewer's view: the artist plus their application. */
export interface PendingArtist { artist: Artist; application?: Application }

interface Catalog {
  status: CatalogStatus;
  error?: string;
  /** Approved artists: everyone listeners can see. */
  artists: Artist[];
  /** Releases that are out. */
  releases: Release[];
  /** Releases scheduled for later (their songs stay hidden until the date), soonest first. */
  upcoming: Release[];
  tracks: Track[];
  /** Approved artists plus your own profile (so your page works while you wait for approval). */
  artistById: Record<string, Artist>;
  releaseById: Record<string, Release>;
  trackById: Record<string, Track>;
  /** The signed-in account's artist profile, if it has one. */
  myProfile?: Artist;
  myReleases: Release[];
  /** Streams per song (plays of 30 seconds or more), from everyone on Milk Crate. */
  streams: Record<string, number>;
  /** Average star rating per album, from everyone on Milk Crate. */
  albumAverages: Record<string, number>;
  /** How many listeners rated each album. */
  albumRatingCounts: Record<string, number>;
  refresh: () => Promise<void>;
  /** Fetches stream counts and album averages again. */
  refreshStats: () => void;
  saveProfile: (profile: ProfileInput) => Promise<void>;
  /** Your application (artist accounts). */
  myApplication?: Application;
  submitApplication: (links: string, note: string, contactEmail?: string) => Promise<void>;
  /** Reviewers: artists waiting for a decision, and recent decisions. */
  loadReviewQueue: () => Promise<PendingArtist[]>;
  reviewArtist: (artistId: string, decision: "approved" | "declined", note?: string) => Promise<void>;
  /** Saves the page design, uploading any photos, logo or font picked from this computer. */
  savePage: (page: ArtistPage, onProgress?: (msg: string) => void) => Promise<void>;
  publishRelease: (release: NewRelease, tracks: NewTrack[], onProgress?: (msg: string) => void) => Promise<Release>;
  removeRelease: (releaseId: string) => Promise<void>;
  /** Saves changes to one of your releases: details, cover, and songs (renamed, reordered, replaced, removed or added). */
  updateRelease: (releaseId: string, edit: ReleaseEdit, tracks: EditTrack[], onProgress?: (msg: string) => void) => Promise<void>;
}

/** "…/storage/v1/object/public/audio/<path>" → "<path>" (only for files in that bucket). */
export function storagePathOf(url: string | undefined | null, bucket: string): string | null {
  if (!url) return null;
  const marker = `/storage/v1/object/public/${bucket}/`;
  const i = url.indexOf(marker);
  return i < 0 ? null : decodeURIComponent(url.slice(i + marker.length).split("?")[0]);
}

const CatalogContext = createContext<Catalog | null>(null);

interface Remote { artists: Artist[]; releases: Release[]; tracks: Track[] }
const EMPTY: Remote = { artists: [], releases: [], tracks: [] };
/** The last catalog loaded, kept on this computer for when there's no internet. */
const CACHE_KEY = "mc.catalogCache";

export function CatalogProvider({ children }: { children: ReactNode }) {
  const { userId } = useAuth();
  const [remote, setRemote] = useState<Remote>(EMPTY);
  const [myApplication, setMyApplication] = useState<Application>();
  const [streams, setStreams] = useState<Record<string, number>>({});
  const [albumAverages, setAlbumAverages] = useState<Record<string, number>>({});
  const [albumRatingCounts, setAlbumRatingCounts] = useState<Record<string, number>>({});

  // Before supabase/007_albums_favorites_streams.sql has been run these views don't exist: then everything is just 0.
  const refreshStats = useCallback(() => {
    supabase.from("track_stream_counts").select("track_id,streams").then(({ data }) => {
      if (data) setStreams(Object.fromEntries(data.map((r) => [r.track_id as string, Number(r.streams)])));
    });
    supabase.from("album_rating_stats").select("release_id,average,ratings").then(({ data }) => {
      if (!data) return;
      setAlbumAverages(Object.fromEntries(data.map((r) => [r.release_id as string, Number(r.average)])));
      setAlbumRatingCounts(Object.fromEntries(data.map((r) => [r.release_id as string, Number(r.ratings)])));
    });
  }, []);
  const [status, setStatus] = useState<CatalogStatus>("loading");
  const [error, setError] = useState<string>();

  const refresh = useCallback(async () => {
    const [a, r, t] = await Promise.all([
      supabase.from("artists").select("*").order("created_at", { ascending: true }),
      supabase.from("releases").select("*").order("created_at", { ascending: false }),
      supabase.from("tracks").select("*"),
    ]);
    const err = a.error ?? r.error ?? t.error;
    if (err) {
      // Offline: fall back to the last catalog this computer saw, so downloaded songs still play.
      const cached = load<Remote | null>(CACHE_KEY, null);
      if (cached) setRemote(cached);
      setStatus("offline");
      setError(err.message);
      return;
    }
    const mapped = releasesFromRows((r.data ?? []) as ReleaseRow[], (t.data ?? []) as TrackRow[]);
    const fresh = { artists: ((a.data ?? []) as ArtistRow[]).map(artistFromRow), ...mapped };
    setRemote(fresh);
    save(CACHE_KEY, fresh);
    setStatus("ready");
    setError(undefined);
    refreshStats();
  }, [refreshStats]);

  // Reload when the account changes: what the server shows depends on who is asking.
  useEffect(() => {
    refresh().catch((e) => {
      const cached = load<Remote | null>(CACHE_KEY, null);
      if (cached) setRemote(cached);
      setStatus("offline");
      setError(String(e?.message ?? e));
    });
  }, [refresh, userId]);

  // New releases and changes show up while the app stays open (quietly; an error keeps what's there).
  useLiveRefresh(() => void refresh().catch(() => {}));

  const myProfile = userId ? remote.artists.find((a) => a.ownerId === userId) : undefined;

  const saveProfile = useCallback(
    async (p: ProfileInput) => {
      if (!userId) throw new Error("Sign in first.");
      const row = {
        owner_id: userId, name: p.name, place: p.place, city: p.city ?? null, state: p.state ?? null, lat: p.lat ?? null, lng: p.lng ?? null,
        genres: p.genres, bio: p.bio, accent: p.accent, since: p.since,
      };
      const country = p.country ?? "US";
      let { error: e } = await supabase.from("artists").upsert({ ...row, country }, { onConflict: "owner_id" });
      // A server without countries yet still takes US artists.
      if (e && country === "US" && /country/i.test(e.message)) ({ error: e } = await supabase.from("artists").upsert(row, { onConflict: "owner_id" }));
      if (e) throw new Error(/country|check constraint/i.test(e.message) ? "the server needs a one-time update: run supabase/006_countries.sql in the Supabase SQL Editor." : e.message);
      await refresh();
    },
    [userId, refresh],
  );

  const myArtistId = myProfile?.id;
  useEffect(() => {
    setMyApplication(undefined);
    if (!myArtistId) return;
    supabase.from("artist_applications").select("*").eq("artist_id", myArtistId).maybeSingle()
      .then(({ data }) => data && setMyApplication(applicationFromRow(data)));
  }, [myArtistId]);

  const submitApplication = useCallback(
    async (links: string, note: string, contactEmail?: string) => {
      if (!myArtistId) throw new Error("Save your artist profile first.");
      const row = { artist_id: myArtistId, links: links.trim(), note: note.trim(), contact_email: contactEmail ?? null, submitted_at: new Date().toISOString() };
      const { data, error: e } = await supabase.from("artist_applications").upsert(row, { onConflict: "artist_id" }).select().single();
      if (e) throw new Error(/relation|does not exist|schema cache/i.test(e.message) ? "the server needs a one-time update: run supabase/003_accounts_and_places.sql in the Supabase SQL Editor." : e.message);
      setMyApplication(applicationFromRow(data));
    },
    [myArtistId],
  );

  const loadReviewQueue = useCallback(async (): Promise<PendingArtist[]> => {
    const [a, p] = await Promise.all([
      supabase.from("artists").select("*").neq("status", "approved").order("created_at", { ascending: true }),
      supabase.from("artist_applications").select("*"),
    ]);
    if (a.error) throw new Error(a.error.message);
    const apps = new Map((p.data ?? []).map((r) => [r.artist_id as string, applicationFromRow(r)]));
    return ((a.data ?? []) as ArtistRow[]).map(artistFromRow).map((artist) => ({ artist, application: apps.get(artist.id) }));
  }, []);

  const reviewArtist = useCallback(
    async (artistId: string, decision: "approved" | "declined", note?: string) => {
      const { error: e } = await supabase.from("artists").update({ status: decision }).eq("id", artistId);
      if (e) throw new Error(e.message);
      if (note !== undefined) await supabase.from("artist_applications").update({ review_note: note || null }).eq("artist_id", artistId);
      await refresh();
    },
    [refresh],
  );

  const savePage = useCallback(
    async (draft: ArtistPage, onProgress?: (msg: string) => void) => {
      if (!userId || !myProfile) throw new Error("Set up your artist profile first.");
      const before = myProfile.page;
      const page: ArtistPage = { ...draft };
      const files = [
        ["banner", "wide banner"],
        ["bannerTall", "vertical banner"],
        ["logo", "logo"],
        ["fontUrl", "font"],
      ] as const;
      const added: string[] = [];
      try {
        for (const [key, label] of files) {
          const url = page[key];
          if (!url || isServerFile(url)) continue;
          onProgress?.(`Uploading your ${label}…`);
          const file = await readLocalFile(url);
          if (file.blob.size > 10 * 1048576) throw new Error(`Your ${label} is over 10 MB. Use a smaller file.`);
          const name = { banner: "banner", bannerTall: "banner-tall", logo: "logo", fontUrl: "font" }[key];
          const path = `${userId}/${name}-${Date.now()}.${file.ext}`;
          const { error: e } = await supabase.storage.from("profiles").upload(path, file.blob, { contentType: file.type, upsert: true });
          if (e) throw new Error(/bucket not found/i.test(e.message) ? e.message : /mime|type/i.test(e.message) ? `That ${label} file type isn't supported.` : `Couldn't upload your ${label}: ${e.message}`);
          added.push(path);
          page[key] = supabase.storage.from("profiles").getPublicUrl(path).data.publicUrl;
        }
        onProgress?.("Saving your page…");
        const { error: e } = await supabase.from("artists").update({ page }).eq("owner_id", userId);
        if (e) throw new Error(e.message);
      } catch (err) {
        const msg = (err as Error).message;
        if (/column .*page|page.*column|bucket not found/i.test(msg))
          err = new Error("the server needs a one-time update: run supabase/002_artist_pages.sql in the Supabase SQL Editor.");
        if (added.length) await supabase.storage.from("profiles").remove(added);
        throw err;
      }
      // Clean up files that were replaced or removed.
      const stale = files.map(([k]) => before[k]).filter((u, i) => u && u !== page[files[i][0]]).map(profilesPath).filter((p): p is string => !!p);
      if (stale.length) await supabase.storage.from("profiles").remove(stale);
      await refresh();
      onProgress?.("");
    },
    [userId, myProfile, refresh],
  );

  const publishRelease = useCallback(
    async (release: NewRelease, tracks: NewTrack[], onProgress?: (msg: string) => void) => {
      if (!userId || !myProfile) throw new Error("Set up your artist profile first.");
      const releaseId = crypto.randomUUID();
      const folder = `${userId}/${releaseId}`;
      const uploaded: { bucket: string; path: string }[] = [];

      const upload = async (bucket: "covers" | "audio", name: string, file: AudioFile) => {
        const path = `${folder}/${name}.${file.ext}`;
        const { error: e } = await supabase.storage.from(bucket).upload(path, file.blob, { contentType: file.type, upsert: true });
        if (e && /maximum allowed size|too large|exceeded/i.test(e.message))
          throw new Error(`"${name}" is bigger than the ${MAX_UPLOAD_MB} MB the server accepts.`);
        if (e) throw new Error(`Upload failed for ${name}: ${e.message}`);
        uploaded.push({ bucket, path });
        return supabase.storage.from(bucket).getPublicUrl(path).data.publicUrl;
      };

      try {
        let artUrl: string | null = null;
        if (release.art) {
          onProgress?.("Uploading cover art…");
          artUrl = await upload("covers", "cover", await readLocalFile(release.art));
        }
        const audioUrls: string[] = [];
        const sounds: (SoundProfile | null)[] = [];
        for (let i = 0; i < tracks.length; i++) {
          const of = `track ${i + 1} of ${tracks.length}`;
          onProgress?.(`Reading ${of}…`);
          const original = await readLocalFile(tracks[i].src);
          onProgress?.(`Listening to ${of}…`);
          sounds.push(await measureSound(original.blob));
          const audio = await prepareAudio(original, (pct) =>
            onProgress?.(`Making a streaming copy of ${of}… ${pct}%`),
          );
          onProgress?.(`Uploading ${of} (${(audio.blob.size / 1048576).toFixed(1)} MB)…`);
          audioUrls.push(await upload("audio", `${String(i + 1).padStart(2, "0")}-${fileSlug(tracks[i].title)}`, audio));
        }

        onProgress?.("Publishing…");
        const { error: re } = await supabase.from("releases").insert({
          id: releaseId, artist_id: myProfile.id, title: release.title, kind: release.kind, year: release.year, art_url: artUrl,
          ...(release.releaseAt ? { release_at: release.releaseAt } : {}),
        });
        if (re) throw new Error(re.message);
        const rows = tracks.map((t, i) => ({ release_id: releaseId, artist_id: myProfile.id, position: i + 1, title: t.title, duration: t.duration, audio_url: audioUrls[i], ...(sounds[i] ? { sound: sounds[i] } : {}) }));
        let { error: te } = await supabase.from("tracks").insert(rows);
        if (te && /sound/i.test(te.message)) {
          // Server not updated for sound profiles yet (004): publish without them.
          ({ error: te } = await supabase.from("tracks").insert(rows.map(({ sound: _s, ...r }: Record<string, unknown>) => r)));
        }
        if (te) {
          await supabase.from("releases").delete().eq("id", releaseId);
          throw new Error(te.message);
        }
      } catch (e) {
        // Don't leave half-uploaded files behind.
        for (const bucket of ["covers", "audio"] as const) {
          const paths = uploaded.filter((u) => u.bucket === bucket).map((u) => u.path);
          if (paths.length) await supabase.storage.from(bucket).remove(paths);
        }
        throw e;
      }

      await refresh();
      onProgress?.("");
      return { id: releaseId, artistId: myProfile.id, title: release.title, kind: release.kind, year: release.year, trackIds: [] };
    },
    [userId, myProfile, refresh],
  );

  const removeRelease = useCallback(
    async (releaseId: string) => {
      if (!userId) throw new Error("Sign in first.");
      for (const bucket of ["covers", "audio"] as const) {
        const { data } = await supabase.storage.from(bucket).list(`${userId}/${releaseId}`);
        if (data?.length) await supabase.storage.from(bucket).remove(data.map((f) => `${userId}/${releaseId}/${f.name}`));
      }
      const { error: e } = await supabase.from("releases").delete().eq("id", releaseId);
      if (e) throw new Error(e.message);
      await refresh();
    },
    [userId, refresh],
  );

  const updateRelease = useCallback(
    async (releaseId: string, edit: ReleaseEdit, tracks: EditTrack[], onProgress?: (msg: string) => void) => {
      if (!userId || !myProfile) throw new Error("Sign in to your artist account first.");
      const before = remote.releases.find((r) => r.id === releaseId);
      if (!before || before.artistId !== myProfile.id) throw new Error("That release isn't yours.");
      if (!tracks.length) throw new Error("A release needs at least one song. To take it down completely, remove the release instead.");
      const oldTracks = remote.tracks.filter((t) => t.releaseId === releaseId);
      const folder = `${userId}/${releaseId}`;
      // New files get a fresh name, so nobody's player (or cache) mixes up the old and new versions.
      const stamp = Date.now().toString(36);
      const uploaded: { bucket: string; path: string }[] = [];
      const upload = async (bucket: "covers" | "audio", name: string, file: AudioFile) => {
        const path = `${folder}/${name}-${stamp}.${file.ext}`;
        const { error: e } = await supabase.storage.from(bucket).upload(path, file.blob, { contentType: file.type, upsert: true });
        if (e && /maximum allowed size|too large|exceeded/i.test(e.message)) throw new Error(`"${name}" is bigger than the ${MAX_UPLOAD_MB} MB the server accepts.`);
        if (e) throw new Error(`Upload failed for ${name}: ${e.message}`);
        uploaded.push({ bucket, path });
        return supabase.storage.from(bucket).getPublicUrl(path).data.publicUrl;
      };
      const toDelete: { bucket: string; path: string }[] = [];
      let saving = false;
      try {
        // 1. Cover.
        let artUrl: string | null | undefined;
        if (edit.art) {
          onProgress?.("Uploading the new cover…");
          artUrl = await upload("covers", "cover", await readLocalFile(edit.art));
        } else if (edit.art === null) artUrl = null;
        if (artUrl !== undefined) {
          const old = storagePathOf(before.art, "covers");
          if (old) toDelete.push({ bucket: "covers", path: old });
        }
        // 2. New audio (new songs, and songs whose file is being replaced).
        const fresh: Record<number, { url: string; sound: SoundProfile | null }> = {};
        const withFiles = tracks.map((t, i) => ({ t, i })).filter(({ t }) => t.src);
        for (let k = 0; k < withFiles.length; k++) {
          const { t, i } = withFiles[k];
          const of = withFiles.length > 1 ? `song ${k + 1} of ${withFiles.length}` : `"${t.title}"`;
          onProgress?.(`Reading ${of}…`);
          const original = await readLocalFile(t.src!);
          onProgress?.(`Listening to ${of}…`);
          const sound = await measureSound(original.blob);
          const audio = await prepareAudio(original, (pct) => onProgress?.(`Making a streaming copy of ${of}… ${pct}%`));
          onProgress?.(`Uploading ${of} (${(audio.blob.size / 1048576).toFixed(1)} MB)…`);
          fresh[i] = { url: await upload("audio", `${String(i + 1).padStart(2, "0")}-${fileSlug(t.title)}`, audio), sound };
        }

        onProgress?.("Saving…");
        saving = true;
        // 3. The release's details.
        const changes: Record<string, unknown> = { title: edit.title, kind: edit.kind, year: edit.year, ...(artUrl !== undefined ? { art_url: artUrl } : {}) };
        if (edit.releaseAt !== (before.releaseAt ?? null)) changes.release_at = edit.releaseAt;
        const { error: re } = await supabase.from("releases").update(changes).eq("id", releaseId);
        if (re) throw new Error(re.message);
        // 4. Songs: update the ones that stay, add the new ones, remove the rest.
        const keepIds = new Set(tracks.map((t) => t.id).filter(Boolean) as string[]);
        for (let i = 0; i < tracks.length; i++) {
          const t = tracks[i];
          const f = fresh[i];
          if (t.id) {
            const old = oldTracks.find((o) => o.id === t.id);
            const row: Record<string, unknown> = { title: t.title, position: i + 1 };
            if (t.lyrics !== undefined && t.lyrics !== (old?.lyrics ?? "")) row.lyrics = t.lyrics || null;
            if (t.credits !== undefined && t.credits !== (old?.credits ?? "")) row.credits = t.credits || null;
            if (f) {
              Object.assign(row, { audio_url: f.url, duration: t.duration, ...(f.sound ? { sound: f.sound } : {}) });
              const oldPath = storagePathOf(old?.src, "audio");
              if (oldPath) toDelete.push({ bucket: "audio", path: oldPath });
            }
            const { error: te } = await supabase.from("tracks").update(row).eq("id", t.id);
            if (te) throw new Error(te.message);
          } else if (f) {
            const row = { release_id: releaseId, artist_id: myProfile.id, position: i + 1, title: t.title, duration: t.duration, audio_url: f.url, ...(f.sound ? { sound: f.sound } : {}),
              ...(t.lyrics ? { lyrics: t.lyrics } : {}), ...(t.credits ? { credits: t.credits } : {}) };
            let { error: te } = await supabase.from("tracks").insert(row);
            if (te && /sound/i.test(te.message)) ({ error: te } = await supabase.from("tracks").insert({ ...row, sound: undefined }));
            if (te) throw new Error(te.message);
          }
        }
        const removed = oldTracks.filter((o) => !keepIds.has(o.id));
        if (removed.length) {
          const { error: de } = await supabase.from("tracks").delete().in("id", removed.map((o) => o.id));
          if (de) throw new Error(de.message);
          for (const o of removed) {
            const path = storagePathOf(o.src, "audio");
            if (path) toDelete.push({ bucket: "audio", path });
          }
        }
      } catch (e) {
        // Don't leave half-uploaded files behind. Once saving has started, new files may already be
        // in use, so they stay (anything already saved stays saved; the error says what didn't).
        if (!saving) for (const bucket of ["covers", "audio"] as const) {
          const paths = uploaded.filter((u) => u.bucket === bucket).map((u) => u.path);
          if (paths.length) await supabase.storage.from(bucket).remove(paths);
        }
        await refresh();
        throw e;
      }
      // 5. Files nothing uses any more.
      for (const bucket of ["covers", "audio"] as const) {
        const paths = toDelete.filter((d) => d.bucket === bucket).map((d) => d.path);
        if (paths.length) await supabase.storage.from(bucket).remove(paths);
      }
      await refresh();
      onProgress?.("");
    },
    [userId, myProfile, remote, refresh],
  );

  // When a scheduled release's date comes, it moves from "coming" to out, and its songs are fetched.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const next = remote.releases.map((r) => (r.releaseAt ? Date.parse(r.releaseAt) : 0)).filter((t) => t > now).sort((x, y) => x - y)[0];
    if (!next) return;
    const id = window.setTimeout(() => {
      setNow(Date.now());
      if (Date.now() >= next) void refresh();
    }, Math.min(next - now + 1000, 6 * 3_600_000));
    return () => window.clearTimeout(id);
  }, [remote.releases, now, refresh]);

  const value = useMemo<Catalog>(() => {
    const approved = remote.artists.filter((a) => a.status === "approved");
    const visible = myProfile && myProfile.status !== "approved" ? [...approved, myProfile] : approved;
    const visibleIds = new Set(visible.map((a) => a.id));
    const allReleases = remote.releases.filter((r) => visibleIds.has(r.artistId));
    const releases = allReleases.filter((r) => !isUpcoming(r, now));
    const upcoming = allReleases.filter((r) => isUpcoming(r, now)).sort((a, b) => Date.parse(a.releaseAt!) - Date.parse(b.releaseAt!));
    const tracks = remote.tracks.filter((t) => visibleIds.has(t.artistId));
    return {
      status,
      error,
      artists: approved,
      releases,
      upcoming,
      tracks,
      artistById: byId(visible),
      releaseById: byId(allReleases),
      trackById: byId(tracks),
      myProfile,
      myReleases: myProfile ? remote.releases.filter((r) => r.artistId === myProfile.id) : [],
      streams,
      albumAverages,
      albumRatingCounts,
      refreshStats,
      refresh,
      saveProfile,
      myApplication,
      submitApplication,
      loadReviewQueue,
      reviewArtist,
      savePage,
      publishRelease,
      removeRelease,
      updateRelease,
    };
  }, [remote, status, error, myProfile, myApplication, streams, albumAverages, albumRatingCounts, refreshStats, refresh, saveProfile, submitApplication, loadReviewQueue, reviewArtist, savePage, publishRelease, removeRelease, updateRelease, now]);

  return <CatalogContext.Provider value={value}>{children}</CatalogContext.Provider>;
}

function applicationFromRow(r: Record<string, unknown>): Application {
  return {
    artistId: String(r.artist_id),
    links: String(r.links ?? ""),
    note: String(r.note ?? ""),
    contactEmail: typeof r.contact_email === "string" ? r.contact_email : undefined,
    reviewNote: typeof r.review_note === "string" ? r.review_note : undefined,
    submittedAt: String(r.submitted_at ?? ""),
  };
}

export function useCatalog() {
  const ctx = useContext(CatalogContext);
  if (!ctx) throw new Error("useCatalog must be used inside <CatalogProvider>");
  return ctx;
}
