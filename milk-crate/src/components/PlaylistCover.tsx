import { useMemo, type CSSProperties } from "react";
import { useCatalog } from "../lib/catalog";
import { usePlayer } from "../lib/player";
import { deleteCover, replaceCover, useFileCover } from "../lib/fileTags";
import { useFileCovers } from "../lib/ripped";
import { dataUrlToBlob, imageAsDataUrl } from "../lib/cd";
import { pickImage } from "../lib/localFiles";
import type { Playlist } from "../lib/library";
import type { Track } from "../lib/types";
import { Sleeve } from "./ui";

/** Where a playlist's own picture is kept (on this computer, with the album covers). */
export const playlistCoverKey = (id: string) => `playlist:${id}`;

/** A playlist's songs, from Milk Crate or from this computer (ripped CDs, your files), in order. */
export function usePlaylistTracks(ids: string[]): (Track | undefined)[] {
  const c = useCatalog();
  const p = usePlayer();
  return useMemo(() => {
    const local = new Map(p.localTracks.map((t) => [t.id, t]));
    return ids.map((id) => c.trackById[id] ?? local.get(id));
  }, [ids, c.trackById, p.localTracks]);
}

/**
 * A playlist's cover: the picture you chose, or one Milk Crate makes from its songs' covers
 * (four different covers as a 2×2 grid, or the first one), or a pattern when there are none.
 */
export function PlaylistCover({ playlist: pl, style }: { playlist: Playlist; style?: CSSProperties }) {
  const c = useCatalog();
  const own = useFileCover(playlistCoverKey(pl.id));
  const tracks = usePlaylistTracks(pl.trackIds);
  const fileKeys = tracks.map((t) => (t && !c.releaseById[t.releaseId] ? t.tags?.cover : undefined));
  const files = useFileCovers(fileKeys);
  const arts = useMemo(() => {
    const out: string[] = [];
    tracks.forEach((t, i) => {
      const art = t ? c.releaseById[t.releaseId]?.art ?? (fileKeys[i] ? files[fileKeys[i]!] : undefined) : undefined;
      if (art && !out.includes(art)) out.push(art);
    });
    return out.slice(0, 4);
  }, [tracks, c.releaseById, files]); // eslint-disable-line react-hooks/exhaustive-deps

  if (own) return <Sleeve src={own} alt={`${pl.name} cover`} style={style} />;
  if (arts.length >= 4)
    return (
      <div className="mc-sleeve playlist-mosaic" style={style} role="img" aria-label={`${pl.name} cover`}>
        {arts.map((a) => <img key={a} src={a} alt="" />)}
      </div>
    );
  return <Sleeve src={arts[0]} seed={`playlist ${pl.name}`} alt={`${pl.name} cover`} style={style} />;
}

/** Pick a picture for a playlist. Returns an error to show, or null. */
export async function choosePlaylistCover(id: string): Promise<string | null> {
  try {
    const src = await pickImage();
    if (!src) return null;
    const url = await imageAsDataUrl(src).catch(() => null);
    if (!url) return "That picture needs to be a JPEG or PNG.";
    await replaceCover(playlistCoverKey(id), dataUrlToBlob(url));
    return null;
  } catch (e) {
    return `Couldn't use that picture: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** Goes back to the cover Milk Crate makes. */
export const clearPlaylistCover = (id: string) => deleteCover(playlistCoverKey(id));
