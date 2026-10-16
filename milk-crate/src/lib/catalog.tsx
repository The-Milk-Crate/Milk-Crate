/**
 * The catalog every screen reads from: artists, releases and tracks on the
 * Milk Crate server (Supabase).
 *
 * Artist accounts apply on "For artists"; once a reviewer approves them,
 * their releases go to Supabase Storage and show up for every listener.
 * Only approved artists appear on public screens (the server enforces this
 * too). An artist always sees their own profile, approved or not.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { byId } from "./format";
import { useAuth } from "./auth";
import { prepareAudio, type AudioFile } from "./transcode";
import { measureSound } from "./measure";
import type { SoundProfile } from "./sound";
import { MAX_UPLOAD_MB } from "../config";
import { isServerFile, profilesPath } from "./artistPage";
import { artistFromRow, fileSlug, readLocalFile, releasesFromRows, supabase, type ArtistRow, type ReleaseRow, type TrackRow } from "./supabase";
import type { Artist, ArtistPage, Release, Track } from "./types";

export type CatalogStatus = "loading" | "ready" | "offline";

export interface NewRelease {
  title: string;
  kind: Release["kind"];
  year: number;
  /** A local URL for the cover (desktop asset URL or browser blob URL), if any. */
  art?: string;
}
export interface NewTrack {
  title: string;
  duration: number;
  /** A local URL for the audio file. */
  src: string;
}
export type ProfileInput = Omit<Artist, "id" | "ownerId" | "page" | "status">;

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
  releases: Release[];
  tracks: Track[];
  /** Approved artists plus your own profile (so your page works while you wait for approval). */
  artistById: Record<string, Artist>;
  releaseById: Record<string, Release>;
  trackById: Record<string, Track>;
  /** The signed-in account's artist profile, if it has one. */
  myProfile?: Artist;
  myReleases: Release[];
  /** Average star rating per track, from everyone on Milk Crate. */
  averages: Record<string, number>;
  refresh: () => Promise<void>;
  refreshAverages: () => void;
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
}

const CatalogContext = createContext<Catalog | null>(null);

interface Remote { artists: Artist[]; releases: Release[]; tracks: Track[] }
const EMPTY: Remote = { artists: [], releases: [], tracks: [] };

export function CatalogProvider({ children }: { children: ReactNode }) {
  const { userId } = useAuth();
  const [remote, setRemote] = useState<Remote>(EMPTY);
  const [myApplication, setMyApplication] = useState<Application>();
  const [averages, setAverages] = useState<Record<string, number>>({});

  const refreshAverages = useCallback(() => {
    supabase.from("track_rating_stats").select("track_id,average").then(({ data }) => {
      if (data) setAverages(Object.fromEntries(data.map((r) => [r.track_id as string, Number(r.average)])));
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
      setStatus("offline");
      setError(err.message);
      return;
    }
    const mapped = releasesFromRows((r.data ?? []) as ReleaseRow[], (t.data ?? []) as TrackRow[]);
    setRemote({ artists: ((a.data ?? []) as ArtistRow[]).map(artistFromRow), ...mapped });
    setStatus("ready");
    setError(undefined);
    refreshAverages();
  }, [refreshAverages]);

  // Reload when the account changes: what the server shows depends on who is asking.
  useEffect(() => {
    refresh().catch((e) => {
      setStatus("offline");
      setError(String(e?.message ?? e));
    });
  }, [refresh, userId]);

  const myProfile = userId ? remote.artists.find((a) => a.ownerId === userId) : undefined;

  const saveProfile = useCallback(
    async (p: ProfileInput) => {
      if (!userId) throw new Error("Sign in first.");
      const row = {
        owner_id: userId, name: p.name, place: p.place, city: p.city ?? null, state: p.state ?? null, lat: p.lat ?? null, lng: p.lng ?? null,
        genres: p.genres, bio: p.bio, accent: p.accent, since: p.since,
      };
      const { error: e } = await supabase.from("artists").upsert(row, { onConflict: "owner_id" });
      if (e) throw new Error(e.message);
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

  const value = useMemo<Catalog>(() => {
    const approved = remote.artists.filter((a) => a.status === "approved");
    const visible = myProfile && myProfile.status !== "approved" ? [...approved, myProfile] : approved;
    const visibleIds = new Set(visible.map((a) => a.id));
    const releases = remote.releases.filter((r) => visibleIds.has(r.artistId));
    const tracks = remote.tracks.filter((t) => visibleIds.has(t.artistId));
    return {
      status,
      error,
      artists: approved,
      releases,
      tracks,
      artistById: byId(visible),
      releaseById: byId(releases),
      trackById: byId(tracks),
      myProfile,
      myReleases: myProfile ? remote.releases.filter((r) => r.artistId === myProfile.id) : [],
      averages,
      refreshAverages,
      refresh,
      saveProfile,
      myApplication,
      submitApplication,
      loadReviewQueue,
      reviewArtist,
      savePage,
      publishRelease,
      removeRelease,
    };
  }, [remote, status, error, myProfile, myApplication, averages, refreshAverages, refresh, saveProfile, submitApplication, loadReviewQueue, reviewArtist, savePage, publishRelease, removeRelease]);

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
