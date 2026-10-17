import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import type { Track } from "../lib/types";

/** Does this song have lyrics or credits to show? */
export const hasSongInfo = (t?: Track) => !!(t?.lyrics || t?.credits);

/** A song's lyrics and credits, as the artist wrote them. */
export function SongInfoContent({ track }: { track: Track }) {
  const credits = (track.credits ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  return (
    <div className="song-info">
      {track.lyrics && (
        <section>
          <span className="catalog eyebrow">Lyrics</span>
          <p className="song-lyrics selectable">{track.lyrics}</p>
        </section>
      )}
      {credits.length > 0 && (
        <section>
          <span className="catalog eyebrow">Credits</span>
          <ul className="song-credits selectable">
            {credits.map((line, i) => {
              const at = line.indexOf(":");
              return at > 0 ? <li key={i}><span className="muted">{line.slice(0, at + 1)}</span> {line.slice(at + 1).trim()}</li> : <li key={i}>{line}</li>;
            })}
          </ul>
        </section>
      )}
    </div>
  );
}

/** Lyrics and credits in a window (from a song's ⋯ menu). */
export function SongInfoDialog({ track, artistName, onClose }: { track: Track; artistName?: string; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    box.current?.querySelector<HTMLElement>("button")?.focus();
    // Listen early (capture): the menu that opens this sits inside a song row that stops key presses from bubbling.
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", onKey, true);
    return () => { window.removeEventListener("keydown", onKey, true); prev?.focus?.(); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // Rendered at the top of the page, not inside the song row it was opened from.
  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()} onClick={(e) => e.stopPropagation()}>
      <div ref={box} className="modal panel song-info-modal" role="dialog" aria-modal="true" aria-labelledby="song-info-title">
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
            {artistName && <span className="catalog eyebrow">{artistName}</span>}
            <h2 id="song-info-title" className="display-md" style={{ overflowWrap: "anywhere" }}>{track.title}</h2>
          </div>
          <button type="button" className="mc-icon-btn" aria-label="Close" onClick={onClose}><X size={18} strokeWidth={1.75} aria-hidden="true" /></button>
        </div>
        <SongInfoContent track={track} />
      </div>
    </div>,
    document.body,
  );
}
