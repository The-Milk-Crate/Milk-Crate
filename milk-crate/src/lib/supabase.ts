/**
 * Supabase client and the mapping between database rows and app types.
 * Tables and permissions are defined in supabase/schema.sql.
 */
import { createClient } from "@supabase/supabase-js";
import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from "../config";
import type { Artist, Release, Track } from "./types";

export const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
});

export interface ArtistRow {
  id: string;
  owner_id: string;
  name: string;
  scene_id: string;
  place: string;
  genres: string[];
  bio: string;
  accent: string;
  since: number;
}

export interface ReleaseRow {
  id: string;
  artist_id: string;
  title: string;
  kind: "Single" | "EP" | "LP";
  year: number;
  catalog_number: string | null;
  art_url: string | null;
  created_at: string;
}

export interface TrackRow {
  id: string;
  release_id: string;
  artist_id: string;
  position: number;
  title: string;
  duration: number;
  audio_url: string;
}

export const artistFromRow = (r: ArtistRow): Artist => ({
  id: r.id,
  ownerId: r.owner_id,
  name: r.name,
  sceneId: r.scene_id,
  place: r.place,
  genres: r.genres ?? [],
  bio: r.bio ?? "",
  accent: r.accent,
  since: r.since,
});

export function releasesFromRows(releases: ReleaseRow[], tracks: TrackRow[]): { releases: Release[]; tracks: Track[] } {
  const sortedTracks = [...tracks].sort((a, b) => a.position - b.position);
  return {
    releases: releases.map((r) => ({
      id: r.id,
      artistId: r.artist_id,
      title: r.title,
      kind: r.kind,
      year: r.year,
      catalogNumber: r.catalog_number ?? undefined,
      art: r.art_url ?? undefined,
      trackIds: sortedTracks.filter((t) => t.release_id === r.id).map((t) => t.id),
    })),
    tracks: sortedTracks.map((t) => ({
      id: t.id,
      releaseId: t.release_id,
      artistId: t.artist_id,
      title: t.title,
      duration: t.duration,
      src: t.audio_url,
    })),
  };
}

const EXT_BY_TYPE: Record<string, string> = {
  "audio/mpeg": "mp3", "audio/mp3": "mp3", "audio/flac": "flac", "audio/x-flac": "flac",
  "audio/wav": "wav", "audio/x-wav": "wav", "audio/wave": "wav", "audio/mp4": "m4a", "audio/x-m4a": "m4a",
  "audio/aac": "aac", "audio/ogg": "ogg", "audio/opus": "opus",
  "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp",
};
const TYPE_BY_EXT: Record<string, string> = {
  mp3: "audio/mpeg", flac: "audio/flac", wav: "audio/wav", m4a: "audio/mp4", aac: "audio/aac", ogg: "audio/ogg", opus: "audio/ogg",
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp",
};

/**
 * Reads a file the app can already display or play (a desktop asset URL or a
 * browser blob URL) and works out its type and extension for upload.
 */
export async function readLocalFile(url: string): Promise<{ blob: Blob; ext: string; type: string }> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Couldn't read the file (${res.status}).`);
  const blob = await res.blob();
  const fromUrl = decodeURIComponent(url).match(/\.([a-z0-9]{2,5})(?:$|[?#])/i)?.[1]?.toLowerCase();
  const ext = EXT_BY_TYPE[blob.type] ?? fromUrl ?? "bin";
  const type = blob.type && blob.type !== "application/octet-stream" ? blob.type : TYPE_BY_EXT[ext] ?? "application/octet-stream";
  return { blob, ext, type };
}

export const fileSlug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 60) || "track";
