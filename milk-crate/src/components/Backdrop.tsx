import { useEffect, useRef, useState } from "react";
import { attachSwirl, setSwirlColors, setSwirlMoving } from "../lib/swirl";
import { usePlayer } from "../lib/player";
import { useCatalog } from "../lib/catalog";
import { useSettings } from "../lib/settings";
import { paletteFromImage, paletteFromSleeve } from "../lib/palette";
import { sleeveSeed } from "../lib/sleeve";
import { fileArtist } from "../lib/fileTags";

/**
 * Behind the frosted glass: once something plays, the album cover's colors
 * swirl slowly across the whole window, in two layers: big, soft pools of
 * color underneath (turning a little faster, offset from the top layer so no
 * dark gaps open up) and the smaller swirl on top. Drawn on one small canvas
 * (see swirl.ts). They drift to the next album's colors
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
  const artistName = t ? c.artistById[t.artistId]?.name ?? fileArtist(t) : "";
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

  const on = !!t && !!colors;
  const moving = on && p.playing;
  useEffect(() => { if (colors) setSwirlColors(colors); }, [colors]);
  useEffect(() => setSwirlMoving(moving), [moving]);
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!glass || !canvas.current) return;
    return attachSwirl(canvas.current, immersive);
  }, [glass, immersive]);

  if (!glass) return null;
  return (
    <div className={`backdrop${immersive ? " backdrop-immersive" : ""}${on ? " on" : ""}${moving ? " moving" : ""}`} aria-hidden="true">
      <canvas ref={canvas} className="swirl-canvas" />
    </div>
  );
}
