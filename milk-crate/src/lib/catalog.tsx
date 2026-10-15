/**
 * The catalog every screen reads from: artists, releases and tracks on the
 * Milk Crate server (Supabase).
 *
 * Artists sign in on "For artists" to create a profile and upload releases;
 * uploads go to Supabase Storage and show up for every listener.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { byId } from "../data/scenes";
import { useAuth } from "./auth";
import { prepareAudio, type AudioFile } from "./transcode";
import { MAX_UPLOAD_MB } from "../config";
import { artistFromRow, fileSlug, readLocalFile, releasesFromRows, supabase, type ArtistRow, type ReleaseRow, type TrackRow } from "./supabase";
import type { Artist, Release, Track } from "./types";

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
export type ProfileInput = Omit<Artist, "id" | "ownerId">;

interface Catalog {
  status: CatalogStatus;
  error?: string;
  artists: Artist[];
  releases: Release[];
  tracks: Track[];
  artistById: Record<string, Artist>;
  releaseById: Record<string, Release>;
  trackById: Record<string, Track>;
  /** The signed-in account's artist profile, if it has one. */
  myProfile?: Artist;
  myReleases: Release[];
  refresh: () => Promise<void>;
  saveProfile: (profile: ProfileInput) => Promise<void>;
  publishRelease: (release: NewRelease, tracks: NewTrack[], onProgress?: (msg: string) => void) => Promise<Release>;
  removeRelease: (releaseId: string) => Promise<void>;
}

const CatalogContext = createContext<Catalog | null>(null);

interface Remote { artists: Artist[]; releases: Release[]; tracks: Track[] }
const EMPTY: Remote = { artists: [], releases: [], tracks: [] };

export function CatalogProvider({ children }: { children: ReactNode }) {
  const { userId } = useAuth();
  const [remote, setRemote] = useState<Remote>(EMPTY);
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
  }, []);

  useEffect(() => {
    refresh().catch((e) => {
      setStatus("offline");
      setError(String(e?.message ?? e));
    });
  }, [refresh]);

  const myProfile = userId ? remote.artists.find((a) => a.ownerId === userId) : undefined;

  const saveProfile = useCallback(
    async (p: ProfileInput) => {
      if (!userId) throw new Error("Sign in first.");
      const row = { owner_id: userId, name: p.name, scene_id: p.sceneId, place: p.place, genres: p.genres, bio: p.bio, accent: p.accent, since: p.since };
      const { error: e } = await supabase.from("artists").upsert(row, { onConflict: "owner_id" });
      if (e) throw new Error(e.message);
      await refresh();
    },
    [userId, refresh],
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
        for (let i = 0; i < tracks.length; i++) {
          const of = `track ${i + 1} of ${tracks.length}`;
          onProgress?.(`Reading ${of}…`);
          const audio = await prepareAudio(await readLocalFile(tracks[i].src), (pct) =>
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
        const { error: te } = await supabase.from("tracks").insert(
          tracks.map((t, i) => ({ release_id: releaseId, artist_id: myProfile.id, position: i + 1, title: t.title, duration: t.duration, audio_url: audioUrls[i] })),
        );
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
    const { artists, releases, tracks } = remote;
    return {
      status,
      error,
      artists,
      releases,
      tracks,
      artistById: byId(artists),
      releaseById: byId(releases),
      trackById: byId(tracks),
      myProfile,
      myReleases: myProfile ? remote.releases.filter((r) => r.artistId === myProfile.id) : [],
      refresh,
      saveProfile,
      publishRelease,
      removeRelease,
    };
  }, [remote, status, error, myProfile, refresh, saveProfile, publishRelease, removeRelease]);

  return <CatalogContext.Provider value={value}>{children}</CatalogContext.Provider>;
}

export function useCatalog() {
  const ctx = useContext(CatalogContext);
  if (!ctx) throw new Error("useCatalog must be used inside <CatalogProvider>");
  return ctx;
}
