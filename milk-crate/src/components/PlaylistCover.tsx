import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { useCatalog } from "../lib/catalog";
import { usePlayer } from "../lib/player";
import { deleteCover, replaceCover, useFileCover } from "../lib/fileTags";
import { useFileCovers } from "../lib/ripped";
import { dataUrlToBlob, imageAsDataUrl } from "../lib/cd";
import { pickImage } from "../lib/localFiles";
import { PLAYLIST_PICTURES, useLibrary, type Playlist } from "../lib/library";
import { load, save, save as saveFlag } from "../lib/storage";
import { supabase } from "../lib/supabase";
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
  const own = usePlaylistPicture(pl);
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

/** A private link to a playlist picture kept with your account (good for 15 minutes, renewed as needed; forgotten on sign-out). */
const signed = new Map<string, Promise<string | null>>();
supabase.auth.onAuthStateChange((event) => { if (event === "SIGNED_OUT") signed.clear(); });
function pictureUrl(coverPath: string): Promise<string | null> {
  if (!signed.has(coverPath)) {
    signed.set(coverPath, supabase.storage.from(PLAYLIST_PICTURES).createSignedUrl(coverPath.split("?")[0], 900)
      .then(({ data }) => data?.signedUrl ?? null).catch(() => null));
    setTimeout(() => signed.delete(coverPath), 12 * 60_000);
  }
  return signed.get(coverPath)!;
}

/**
 * The picture chosen for a playlist: the one kept with your account (so every computer shows it),
 * else one saved on this computer before pictures were kept with accounts.
 */
export function usePlaylistPicture(pl: Playlist): string | undefined {
  const local = useFileCover(playlistCoverKey(pl.id));
  const [server, setServer] = useState<string | null>(null);
  useEffect(() => {
    setServer(null);
    if (!pl.coverPath) return;
    let live = true;
    void pictureUrl(pl.coverPath).then((u) => live && setServer(u));
    return () => { live = false; };
  }, [pl.coverPath]);
  useMovePictureToAccount(pl, local);
  return pl.coverPath ? server ?? local : local;
}

const moving = new Set<string>();
/**
 * A picture chosen before pictures were kept with accounts is only on this computer: send it up
 * once, so the others show it too. If it was sent before and the playlist has none now, it was
 * removed on another computer: forget it here as well.
 */
function useMovePictureToAccount(pl: Playlist, local: string | undefined) {
  const lib = useLibrary();
  useEffect(() => {
    if (!lib.signedIn || !local || moving.has(pl.id)) return;
    const flag = `mc.playlistPictureSent.${pl.id}`;
    const sent = load<boolean>(flag, false);
    if (pl.coverPath) { if (!sent) save(flag, true); return; }
    moving.add(pl.id);
    if (sent) {
      void deleteCover(playlistCoverKey(pl.id)).finally(() => moving.delete(pl.id));
      return;
    }
    void lib.setPlaylistPicture(pl.id, dataUrlToBlob(local))
      .then(() => save(flag, true))
      .catch(() => {})
      .finally(() => moving.delete(pl.id));
  }, [lib.signedIn, local, pl.coverPath, pl.id]); // eslint-disable-line react-hooks/exhaustive-deps
}

/** A playlist picture, shrunk to a JPEG up to 640px (playlist covers don't need more). */
async function asJpeg(blob: Blob): Promise<Blob> {
  const bmp = await createImageBitmap(blob);
  const scale = Math.min(1, 640 / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bmp.width * scale));
  canvas.height = Math.max(1, Math.round(bmp.height * scale));
  canvas.getContext("2d")!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close();
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Couldn't read that picture."))), "image/jpeg", 0.85));
}

type SavePicture = (id: string, picture: Blob | null) => Promise<void>;

/**
 * Pick a picture for a playlist. It shows right away on this computer and is saved with your
 * account, so your other computers show it too. Returns an error to show, or null.
 */
export async function choosePlaylistCover(id: string, save: SavePicture): Promise<string | null> {
  try {
    const src = await pickImage();
    if (!src) return null;
    const url = await imageAsDataUrl(src).catch(() => null);
    if (!url) return "That picture needs to be a JPEG or PNG.";
    const jpeg = await asJpeg(dataUrlToBlob(url));
    await replaceCover(playlistCoverKey(id), jpeg);
    try {
      await save(id, jpeg);
      saveFlag(`mc.playlistPictureSent.${id}`, true);
    } catch {
      return "The picture is set on this computer, but couldn't be saved with your account, so your other computers won't show it yet. Try again when you're online.";
    }
    return null;
  } catch (e) {
    return `Couldn't use that picture: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** Goes back to the cover Milk Crate makes, on every computer. */
export async function clearPlaylistCover(id: string, save?: SavePicture) {
  await deleteCover(playlistCoverKey(id));
  if (save) await save(id, null).catch(() => {});
}
