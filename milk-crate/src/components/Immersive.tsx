import { useEffect, useRef, useState } from "react";
import { Minimize2, ScrollText } from "lucide-react";
import { SongInfoContent, hasSongInfo } from "./SongInfo";
import type { Go } from "../App";
import { usePlayer } from "../lib/player";
import { useCatalog } from "../lib/catalog";
import { sleeveSeed } from "../lib/sleeve";
import { enterFullscreen } from "../lib/fullscreen";
import { Backdrop } from "./Backdrop";
import { FrostGrain } from "./FrostGrain";
import { SeekBar } from "./SeekBar";
import { VolumeIcon } from "./VolumePopover";
import { RepeatButton, ShuffleButton } from "./PlayerBar";
import { albumKey, fileArtist, useFileCover } from "../lib/fileTags";
import { Glyph, PlayButton, Sleeve } from "./ui";
import { ImmersiveLibrary } from "./ImmersiveLibrary";

const IDLE_MS = 3000;

/**
 * Immersive mode: the album that's playing, full screen, with its colors
 * swirling behind it. The progress bar and play controls always stay up; the
 * exit button fades out when the mouse rests and comes back when
 * it moves. Esc (or the button) leaves; Space plays/pauses.
 */
export function Immersive({ go, onClose }: { go: Go; onClose: () => void }) {
  const p = usePlayer();
  const c = useCatalog();
  const t = p.current;
  const release = t ? c.releaseById[t.releaseId] : undefined;
  const artist = t ? c.artistById[t.artistId] : undefined;
  // Songs from your computer (ripped CDs included): the cover, artist and album from the file's tags.
  const fileCover = useFileCover(release ? undefined : t?.tags?.cover);
  const localAlbum = !release && t?.tags?.album ? { title: t.tags.album, year: t.tags.year, key: albumKey(t) } : undefined;
  const artistName = artist?.name ?? ((t && fileArtist(t)) || (t ? "Your files" : ""));
  const [idle, setIdle] = useState(false);
  // Lyrics and credits take the cover's place while they're open (and stay open from song to song).
  const [showInfo, setShowInfo] = useState(false);
  // The mini library on the left edge. Opening it shrinks the cover to fit beside it; each change
  // runs the glass sheen across the cover once (two alternating names so it restarts every time).
  const [libOpen, setLibOpen] = useState(false);
  const [sheen, setSheen] = useState(0);
  const setLib = (open: boolean) => { setLibOpen(open); setSheen((n) => n + 1); };
  const libOpenRef = useRef(libOpen);
  libOpenRef.current = libOpen;
  const closeLib = useRef(() => setLib(false));
  const dialog = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const toggle = useRef(p.toggle);
  toggle.current = p.toggle;

  // Tells the main swirl behind this to stop drawing while immersive mode covers it.
  useEffect(() => {
    document.documentElement.dataset.immersive = "true";
    return () => { delete document.documentElement.dataset.immersive; };
  }, []);

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
      if (e.key === "Escape") {
        if (libOpenRef.current) closeLib.current(); // Esc closes the library first
        else close.current();
      }
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
    <div ref={dialog} tabIndex={-1} className={`immersive${idle && !libOpen ? " idle" : ""}${libOpen ? " lib-open" : ""}`} role="dialog" aria-modal="true" aria-label="Immersive mode">
      <Backdrop immersive />
      <button type="button" className="immersive-exit" onClick={onClose}>
        <Minimize2 size={16} strokeWidth={1.75} aria-hidden="true" /> Exit immersive mode <kbd>Esc</kbd>
      </button>
      <ImmersiveLibrary open={libOpen} onOpen={() => setLib(true)} onClose={() => setLib(false)} onFullLibrary={() => openPage({ name: "crate" })} />
      <div className={`immersive-stage${sheen ? ` sheen-${sheen % 2 ? "a" : "b"}` : ""}`}>
        {showInfo && hasSongInfo(t) ? (
          <div className="immersive-lyrics" aria-label={`Lyrics and credits for ${t.title}`}><SongInfoContent track={t} /></div>
        ) : (
          <Sleeve src={release?.art ?? fileCover} seed={release ? sleeveSeed(release.title, artistName) : sleeveSeed(localAlbum?.title ?? t.title, artistName)}
            alt={release ? `${release.title} cover` : localAlbum ? `${localAlbum.title} cover` : ""} />
        )}
        <div className="immersive-side">
        <div className="immersive-card">
        <FrostGrain source="immersive" saturate={1.5} />
        <div className="immersive-info">
          {release && (
            <button type="button" className="catalog eyebrow immersive-link" onClick={() => openPage({ name: "album", releaseId: release.id })}>
              {[release.title, release.year].filter(Boolean).join(" · ")}
            </button>
          )}
          {localAlbum && (
            localAlbum.key ? (
              <button type="button" className="catalog eyebrow immersive-link" onClick={() => openPage({ name: "computer", album: localAlbum.key })}>
                {[localAlbum.title, localAlbum.year].filter(Boolean).join(" · ")}
              </button>
            ) : (
              <span className="catalog eyebrow">{[localAlbum.title, localAlbum.year].filter(Boolean).join(" · ")}</span>
            )
          )}
          <h1 className="immersive-title">{t.title}</h1>
          {artist ? (
            <button type="button" className="immersive-artist immersive-link" onClick={() => openPage({ name: "artist", artistId: artist.id })}>{artist.name}</button>
          ) : (
            <span className="immersive-artist">{artistName}</span>
          )}
          <SeekBar className="immersive-seek" />
          <div className="immersive-controls">
            <ShuffleButton />
            <button type="button" className="mc-icon-btn" aria-label="Previous" onClick={p.prev}><Glyph.prev /></button>
            <PlayButton size="lg" playing={p.playing} onClick={p.toggle} />
            <button type="button" className="mc-icon-btn" aria-label="Next" onClick={p.next}><Glyph.next /></button>
            <RepeatButton />
          </div>
          {hasSongInfo(t) && (
            <button type="button" className={`immersive-lyrics-btn${showInfo ? " on" : ""}`} aria-pressed={showInfo} onClick={() => setShowInfo((v) => !v)}>
              <ScrollText size={15} strokeWidth={1.75} aria-hidden="true" /> {showInfo ? "Show the cover" : t.lyrics ? "Lyrics" : "Credits"}
            </button>
          )}
        </div>
        </div>
        {/* The volume: its own glass pill under the song's card. */}
        <ImmersiveVolume />
        </div>
      </div>
    </div>
  );
}

function ImmersiveVolume() {
  const p = usePlayer();
  const level = Math.round((p.muted ? 0 : p.volume) * 100);
  const box = useRef<HTMLDivElement>(null);
  // Scrolling over it turns it up or down.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      p.setVolume(Math.max(0, Math.min(100, level + (e.deltaY < 0 ? 5 : -5))) / 100);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  });
  return (
    <div ref={box} className="immersive-volume">
      <FrostGrain source="immersive" saturate={1.5} />
      <button type="button" className="mc-icon-btn" aria-label={p.muted ? "Unmute" : "Mute"} aria-pressed={p.muted} onClick={() => p.setMuted(!p.muted)}>
        <VolumeIcon />
      </button>
      <input type="range" className="volume-slider mc-range" min={0} max={100} step={1} aria-label="Volume" value={level}
        onChange={(e) => p.setVolume(Number(e.target.value) / 100)}
        style={{ "--v": level / 100 } as React.CSSProperties} />
    </div>
  );
}
