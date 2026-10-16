import { useEffect, useState } from "react";
import { usePlayer } from "../lib/player";
import { useCatalog } from "../lib/catalog";
import { useSettings } from "../lib/settings";
import { paletteFromImage, paletteFromSleeve } from "../lib/palette";
import { sleeveSeed } from "../lib/sleeve";

/**
 * Behind the frosted glass: once something plays, the album cover's colors
 * swirl slowly across the whole window. They drift to the next album's colors
 * when the music changes, hold still while paused, and fade away when nothing
 * is loaded (leaving the plain frosted window). Immersive mode uses it too,
 * full strength, whether or not glass is on.
 */
export function Backdrop({ immersive = false }: { immersive?: boolean }) {
  const p = usePlayer();
  const c = useCatalog();
  const { glass: glassOn } = useSettings();
  const glass = glassOn || immersive; // immersive mode always shows the colors
  const t = p.current;
  const release = t ? c.releaseById[t.releaseId] : undefined;
  const artistName = t ? c.artistById[t.artistId]?.name ?? "" : "";
  const key = !t ? null : release?.art ? `art:${release.art}` : release ? `sleeve:${sleeveSeed(release.title, artistName)}` : `track:${t.title}`;
  const [colors, setColors] = useState<string[] | null>(null);

  useEffect(() => {
    if (!key || !glass) return;
    let live = true;
    const fallback = () => paletteFromSleeve(key);
    if (key.startsWith("art:")) {
      paletteFromImage(key.slice(4))
        .then((p) => live && setColors(p.length ? p : fallback()))
        .catch(() => live && setColors(fallback()));
    } else {
      setColors(paletteFromSleeve(key.replace(/^(sleeve|track):/, "")));
    }
    return () => {
      live = false;
    };
  }, [key, glass]);

  if (!glass) return null;
  const on = !!t && !!colors;
  const style = colors ? Object.fromEntries(colors.map((col, i) => [`--swirl-${i + 1}`, col])) : undefined;
  return (
    <div className={`backdrop${immersive ? " backdrop-immersive" : ""}${on ? " on" : ""}${on && p.playing ? " moving" : ""}`} style={style} aria-hidden="true">
      <div className="swirl">
        <i className="blob b1" />
        <i className="blob b2" />
        <i className="blob b3" />
        <i className="blob b4" />
      </div>
    </div>
  );
}
