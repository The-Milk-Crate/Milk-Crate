import { useEffect } from "react";
import { usePlayer } from "./player";
import { accentForHue, applyAccent, defaultAccent, hueFromImage, type Theme } from "./accent";
import { sleeveHue, sleeveSeed } from "./sleeve";
import { useCatalog } from "./catalog";

/**
 * Keeps the UI accent in step with what's playing.
 * Lavender when nothing plays (or when turned off, or the track has no art);
 * otherwise the album's signature hue at lavender's lightness and chroma.
 */
export function useAlbumAccent(theme: Theme, enabled: boolean) {
  const { current } = usePlayer();
  const { artistById, releaseById } = useCatalog();

  useEffect(() => {
    let cancelled = false;
    const release = current ? releaseById[current.releaseId] : undefined;

    if (!enabled || !current || !release) {
      applyAccent(defaultAccent(theme));
      return;
    }

    if (release.art) {
      // Real artist art: sample the image. Fall back to lavender for greyscale art or errors.
      hueFromImage(release.art)
        .then((hue) => !cancelled && applyAccent(hue == null ? defaultAccent(theme) : accentForHue(hue, theme)))
        .catch(() => !cancelled && applyAccent(defaultAccent(theme)));
    } else {
      const artist = artistById[release.artistId]?.name ?? "";
      applyAccent(accentForHue(sleeveHue(sleeveSeed(release.title, artist)), theme));
    }
    return () => {
      cancelled = true;
    };
  }, [current?.id, current?.releaseId, theme, enabled, artistById, releaseById]);
}
