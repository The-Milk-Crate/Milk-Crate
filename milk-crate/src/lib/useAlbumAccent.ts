import { useEffect } from "react";
import { usePlayer } from "./player";
import { accentForColor, accentForHue, applyAccent, hueFromImage, type Theme } from "./accent";
import { sleeveHue, sleeveSeed } from "./sleeve";
import { useCatalog } from "./catalog";
import { getCover } from "./fileTags";

/**
 * Keeps the UI accent in step with what's playing.
 * Your own accent (lavender unless you picked one) when nothing plays, when
 * album colors are off, or when the art is greyscale;
 * otherwise the album's signature hue at lavender's lightness and chroma.
 */
export function useAlbumAccent(theme: Theme, enabled: boolean, own: string | null = null) {
  const { current } = usePlayer();
  const { artistById, releaseById } = useCatalog();

  useEffect(() => {
    let cancelled = false;
    const base = () => accentForColor(own, theme);
    const release = current ? releaseById[current.releaseId] : undefined;

    if (!enabled || !current) {
      applyAccent(base());
      return;
    }
    // A song from your computer (a ripped CD, your files): the cover inside the file.
    if (!release) {
      const key = current.tags?.cover;
      if (!key) { applyAccent(base()); return; }
      getCover(key)
        .then((url) => (url ? hueFromImage(url) : null))
        .then((hue) => !cancelled && applyAccent(hue == null ? base() : accentForHue(hue, theme)))
        .catch(() => !cancelled && applyAccent(base()));
      return () => { cancelled = true; };
    }

    if (release.art) {
      // Real artist art: sample the image. Fall back to lavender for greyscale art or errors.
      hueFromImage(release.art)
        .then((hue) => !cancelled && applyAccent(hue == null ? base() : accentForHue(hue, theme)))
        .catch(() => !cancelled && applyAccent(base()));
    } else {
      const artist = artistById[release.artistId]?.name ?? "";
      applyAccent(accentForHue(sleeveHue(sleeveSeed(release.title, artist)), theme));
    }
    return () => {
      cancelled = true;
    };
  }, [current?.id, current?.releaseId, current?.tags?.cover, theme, enabled, own, artistById, releaseById]);
}
