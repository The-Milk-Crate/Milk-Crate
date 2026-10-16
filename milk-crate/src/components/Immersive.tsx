import { useEffect, useRef, useState } from "react";
import { Minimize2 } from "lucide-react";
import type { Go } from "../App";
import { usePlayer } from "../lib/player";
import { useCatalog } from "../lib/catalog";
import { sleeveSeed } from "../lib/sleeve";
import { enterFullscreen } from "../lib/fullscreen";
import { Backdrop } from "./Backdrop";
import { SeekBar } from "./SeekBar";
import { Glyph, PlayButton, Sleeve } from "./ui";

const IDLE_MS = 3000;

/**
 * Immersive mode: the album that's playing, full screen, with its colors
 * swirling behind it. The controls fade out when the mouse rests and come
 * back when it moves. Esc (or the button) leaves; Space plays/pauses.
 */
export function Immersive({ go, onClose }: { go: Go; onClose: () => void }) {
  const p = usePlayer();
  const c = useCatalog();
  const t = p.current;
  const release = t ? c.releaseById[t.releaseId] : undefined;
  const artist = t ? c.artistById[t.artistId] : undefined;
  const artistName = artist?.name ?? (t ? "Your files" : "");
  const at = t ? p.queue.findIndex((q) => q.id === t.id) : -1;
  const upNext = at >= 0 ? p.queue[at + 1] : undefined;
  const [idle, setIdle] = useState(false);
  const dialog = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const toggle = useRef(p.toggle);
  toggle.current = p.toggle;

  // Full screen while open; put the window back the way it was on the way out.
  useEffect(() => {
    let restore: Awaited<ReturnType<typeof enterFullscreen>> | null = null;
    let open = true;
    void enterFullscreen().then((r) => (open ? (restore = r) : void r()));
    // In a browser, Esc leaves full screen before the page sees the key: treat that as leaving immersive mode.
    const onFs = () => !document.fullscreenElement && restore?.entered && close.current();
    document.addEventListener("fullscreenchange", onFs);
    dialog.current?.focus(); // so Space plays/pauses right away
    return () => {
      open = false;
      document.removeEventListener("fullscreenchange", onFs);
      void restore?.();
    };
  }, []);

  // Keys, and hiding the controls when the mouse rests.
  useEffect(() => {
    let timer = 0;
    const wake = () => {
      setIdle(false);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setIdle(true), IDLE_MS);
    };
    const onKey = (e: KeyboardEvent) => {
      wake();
      if (e.key === "Escape") close.current();
      else if (e.key === " " && !(e.target as HTMLElement).closest?.("button, input, [role=slider]")) {
        e.preventDefault();
        toggle.current();
      }
    };
    wake();
    window.addEventListener("pointermove", wake);
    window.addEventListener("pointerdown", wake);
    window.addEventListener("keydown", onKey);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("pointermove", wake);
      window.removeEventListener("pointerdown", wake);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  // Nothing loaded (queue cleared): nothing to be immersed in.
  useEffect(() => {
    if (!t) close.current();
  }, [t]);
  if (!t) return null;

  const openPage = (r: Parameters<Go>[0]) => {
    onClose();
    go(r);
  };

  return (
    <div ref={dialog} tabIndex={-1} className={`immersive${idle ? " idle" : ""}`} role="dialog" aria-modal="true" aria-label="Immersive mode">
      <Backdrop immersive />
      <button type="button" className="immersive-exit" onClick={onClose}>
        <Minimize2 size={16} strokeWidth={1.75} aria-hidden="true" /> Exit immersive mode <kbd>Esc</kbd>
      </button>
      <div className="immersive-stage">
        <Sleeve src={release?.art} seed={release ? sleeveSeed(release.title, artistName) : t.title} alt={release ? `${release.title} cover` : ""} />
        <div className="immersive-info">
          {release && (
            <button type="button" className="catalog eyebrow immersive-link" onClick={() => openPage({ name: "album", releaseId: release.id })}>
              {[release.title, release.year].filter(Boolean).join(" · ")}
            </button>
          )}
          <h1 className="immersive-title">{t.title}</h1>
          {artist ? (
            <button type="button" className="immersive-artist immersive-link" onClick={() => openPage({ name: "artist", artistId: artist.id })}>{artist.name}</button>
          ) : (
            <span className="immersive-artist">{artistName}</span>
          )}
          <SeekBar className="immersive-seek" />
          <div className="immersive-controls">
            <button type="button" className="mc-icon-btn" aria-label="Previous" onClick={p.prev}><Glyph.prev /></button>
            <PlayButton size="lg" playing={p.playing} onClick={p.toggle} />
            <button type="button" className="mc-icon-btn" aria-label="Next" onClick={p.next}><Glyph.next /></button>
          </div>
          <p className="caption immersive-next">{upNext ? <>Up next: <strong>{upNext.title}</strong></> : "Last song in the queue"}</p>
        </div>
      </div>
    </div>
  );
}
