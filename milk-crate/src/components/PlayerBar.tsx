import { usePlayer } from "../lib/player";
import { formatTime } from "../lib/format";
import { useCatalog } from "../lib/catalog";
import { sleeveSeed } from "../lib/sleeve";
import { Glyph, PlayButton, Sleeve } from "./ui";

/** The persistent player along the bottom of the window. */
export function PlayerBar() {
  const p = usePlayer();
  const { artistById, releaseById } = useCatalog();
  const t = p.current;
  const artist = t ? artistById[t.artistId]?.name ?? "Your files" : "";
  const release = t ? releaseById[t.releaseId] : undefined;
  const pct = p.duration ? (p.elapsed / p.duration) * 100 : 0;

  return (
    <div className="mc-player" role="region" aria-label="Player">
      <div className="mc-player-now">
        {t ? (
          <>
            <Sleeve src={release?.art} seed={release ? sleeveSeed(release.title, artist) : t.title} />
            <div style={{ minWidth: 0 }}>
              <div className="mc-track-title">{t.title}</div>
              <div className="mc-track-artist">{artist}</div>
            </div>
          </>
        ) : (
          <span className="muted">Nothing playing. Pick a record.</span>
        )}
      </div>

      <div className="mc-player-center">
        <div className="mc-player-controls">
          <button type="button" className="mc-icon-btn" aria-label="Previous" onClick={p.prev} disabled={!t}><Glyph.prev /></button>
          <PlayButton playing={p.playing} onClick={p.toggle} />
          <button type="button" className="mc-icon-btn" aria-label="Next" onClick={p.next} disabled={!t}><Glyph.next /></button>
        </div>
        <div className="mc-progress">
          <span style={{ textAlign: "right" }}>{formatTime(p.elapsed)}</span>
          <div
            className="mc-progress-track"
            role="slider"
            tabIndex={t ? 0 : -1}
            aria-label="Seek"
            aria-valuemin={0}
            aria-valuemax={Math.round(p.duration)}
            aria-valuenow={Math.round(p.elapsed)}
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              p.seek((e.clientX - r.left) / r.width);
            }}
            onKeyDown={(e) => {
              if (!p.duration) return;
              if (e.key === "ArrowRight") p.seek((p.elapsed + 5) / p.duration);
              if (e.key === "ArrowLeft") p.seek((p.elapsed - 5) / p.duration);
            }}
            style={{ cursor: t ? "pointer" : "default" }}
          >
            <div className="mc-progress-fill" style={{ width: `${pct}%` }} />
          </div>
          <span>{formatTime(p.duration)}</span>
        </div>
      </div>

      <div className="mc-player-side">
      </div>
    </div>
  );
}
