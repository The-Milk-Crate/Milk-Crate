import { usePlayer } from "../lib/player";
import { useCatalog } from "../lib/catalog";
import { sleeveSeed } from "../lib/sleeve";
import { Maximize2, Volume1, Volume2, VolumeX } from "lucide-react";
import type { Go } from "../App";
import { SeekBar } from "./SeekBar";
import { Glyph, PlayButton, Sleeve } from "./ui";

/** The persistent player along the bottom of the window. */
export function PlayerBar({ go, onImmersive }: { go: Go; onImmersive: () => void }) {
  const p = usePlayer();
  const { artistById, releaseById } = useCatalog();
  const t = p.current;
  const artist = t ? artistById[t.artistId]?.name ?? "Your files" : "";
  const release = t ? releaseById[t.releaseId] : undefined;

  return (
    <div className="mc-player" role="region" aria-label="Player">
      <div className="mc-player-now">
        {t ? (
          <>
            <button type="button" className="mc-player-art" aria-label="Immersive mode" title="Immersive mode" onClick={onImmersive}>
              <Sleeve src={release?.art} seed={release ? sleeveSeed(release.title, artist) : t.title} />
            </button>
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
        <SeekBar />
      </div>

      <div className="mc-player-side">
        <div className="volume">
          <button type="button" className="mc-icon-btn" aria-label={p.muted ? "Unmute" : "Mute"} aria-pressed={p.muted} onClick={() => p.setMuted(!p.muted)}>
            {p.muted || p.volume === 0 ? <VolumeX size={18} strokeWidth={1.75} aria-hidden="true" /> : p.volume < 0.5 ? <Volume1 size={18} strokeWidth={1.75} aria-hidden="true" /> : <Volume2 size={18} strokeWidth={1.75} aria-hidden="true" />}
          </button>
          <input type="range" className="volume-slider" min={0} max={100} step={1} aria-label="Volume"
            value={Math.round((p.muted ? 0 : p.volume) * 100)} onChange={(e) => p.setVolume(Number(e.target.value) / 100)}
            style={{ "--fill": `${Math.round((p.muted ? 0 : p.volume) * 100)}%` } as React.CSSProperties} />
          <button type="button" className={`eq-btn${p.eqOn ? " on" : ""}`} aria-label={`Equalizer settings (equalizer ${p.eqOn ? "on" : "off"})`}
            title={`Equalizer ${p.eqOn ? "on" : "off"}. Open equalizer settings.`} onClick={() => go({ name: "settings", tab: "sound" })}>EQ</button>
        </div>
        <button type="button" className="mc-icon-btn" aria-label="Immersive mode" title="Immersive mode" onClick={onImmersive} disabled={!t}>
          <Maximize2 size={18} strokeWidth={1.75} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
