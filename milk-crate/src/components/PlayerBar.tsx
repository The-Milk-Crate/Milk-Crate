import { useRef, useState } from "react";
import { usePlayer } from "../lib/player";
import { EqPopover } from "./EqPopover";
import { useCatalog } from "../lib/catalog";
import { sleeveSeed } from "../lib/sleeve";
import { ListMusic, Maximize2, Repeat, Repeat1, Shuffle, Volume1, Volume2, VolumeX } from "lucide-react";
import type { Go } from "../App";
import { SeekBar } from "./SeekBar";
import { Glyph, PlayButton, Sleeve } from "./ui";
import { fileArtist, useFileCover } from "../lib/fileTags";

/** The persistent player along the bottom of the window. */
export function PlayerBar({ go, onImmersive, queueOpen, onQueue }: { go: Go; onImmersive: () => void; queueOpen: boolean; onQueue: () => void }) {
  const p = usePlayer();
  const [eqOpen, setEqOpen] = useState(false);
  const eqBtn = useRef<HTMLButtonElement>(null);
  const { artistById, releaseById } = useCatalog();
  const t = p.current;
  const artist = t ? artistById[t.artistId]?.name ?? (fileArtist(t) || "Your Computer") : "";
  const release = t ? releaseById[t.releaseId] : undefined;
  const fileCover = useFileCover(t?.tags?.cover);

  return (
    <div className="mc-player" role="region" aria-label="Player">
      <div className="mc-player-now">
        {t ? (
          <>
            {/* The cover nearly fills the bar; the heart is a little glass bubble on its corner. */}
            <div className="mc-player-cover">
              <button type="button" className="mc-player-art" aria-label="Immersive mode" title="Immersive mode" onClick={onImmersive}>
                <Sleeve src={release?.art ?? fileCover} seed={release ? sleeveSeed(release.title, artist) : t.title} />
              </button>
              <GlassHeart on={p.isFavorite(t.id)} title={t.title} onToggle={() => p.toggleFavorite(t.id)} />
            </div>
            <div style={{ minWidth: 0 }}>
              <div className="mc-player-title-row">
                <span className="mc-track-title">{t.title}</span>
              </div>
              <div className="mc-track-artist">{artist}</div>
            </div>
          </>
        ) : (
          <span className="muted">Nothing playing. Pick a record.</span>
        )}
      </div>

      <div className="mc-player-center">
        <div className="mc-player-controls">
          <ShuffleButton />
          <button type="button" className="mc-icon-btn" aria-label="Previous" onClick={p.prev} disabled={!t}><Glyph.prev /></button>
          <PlayButton playing={p.playing} onClick={p.toggle} />
          <button type="button" className="mc-icon-btn" aria-label="Next" onClick={p.next} disabled={!t}><Glyph.next /></button>
          <RepeatButton />
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
          <button ref={eqBtn} type="button" className={`eq-btn${p.eqOn ? " on" : ""}`} aria-label={`Equalizer (${p.eqOn ? "on" : "off"})`}
            aria-expanded={eqOpen} aria-haspopup="dialog" title={`Equalizer ${p.eqOn ? "on" : "off"}`} onClick={() => setEqOpen((o) => !o)}>EQ</button>
          {eqOpen && <EqPopover anchor={eqBtn} onClose={() => setEqOpen(false)} onMore={() => go({ name: "settings", tab: "sound" })} />}
        </div>
        <button type="button" className={`mc-icon-btn${queueOpen ? " on" : ""}`} aria-label="Queue" aria-pressed={queueOpen} title="Queue" onClick={onQueue}>
          <ListMusic size={18} strokeWidth={1.75} aria-hidden="true" />
        </button>
        <button type="button" className="mc-icon-btn" aria-label="Immersive mode" title="Immersive mode" onClick={onImmersive} disabled={!t}>
          <Maximize2 size={18} strokeWidth={1.75} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

/** Shuffle on/off, opposite the repeat button so the play button sits in the middle. */
export function ShuffleButton() {
  const p = usePlayer();
  return (
    <button type="button" className={`mc-icon-btn repeat-btn${p.shuffleOn ? " on" : ""}`} aria-pressed={p.shuffleOn}
      aria-label="Shuffle" title={p.shuffleOn ? "Shuffle on" : "Shuffle off"} onClick={() => p.setShuffle(!p.shuffleOn)}>
      <Shuffle size={17} strokeWidth={1.9} aria-hidden="true" />
    </button>
  );
}

/** Repeat: off → the whole queue → this song. */
export function RepeatButton() {
  const p = usePlayer();
  return (
    <button type="button" className={`mc-icon-btn repeat-btn${p.repeat !== "off" ? " on" : ""}`} aria-pressed={p.repeat !== "off"}
      aria-label={p.repeat === "off" ? "Repeat: off" : p.repeat === "all" ? "Repeat: the whole queue" : "Repeat: this song"}
      title={p.repeat === "off" ? "Repeat off" : p.repeat === "all" ? "Repeating the queue" : "Repeating this song"}
      onClick={() => p.setRepeat(p.repeat === "off" ? "all" : p.repeat === "all" ? "one" : "off")}>
      {p.repeat === "one" ? <Repeat1 size={17} strokeWidth={1.9} aria-hidden="true" /> : <Repeat size={17} strokeWidth={1.9} aria-hidden="true" />}
    </button>
  );
}

const HEART = "M12 21.2C11.7 21 3.9 16.2 2.1 11.3 .8 7.6 3.4 3.8 7.4 3.8c1.9 0 3.5.9 4.6 2.3 1.1-1.4 2.7-2.3 4.6-2.3 4 0 6.6 3.8 5.3 7.5-1.8 4.9-9.6 9.7-9.9 9.9Z";

/**
 * Favorite, as a heart-shaped bubble of glass on the cover's corner: it pops up when you hover the
 * cover (or tab to it), and once the song is a favorite it stays, tinted with the accent.
 */
function GlassHeart({ on, title, onToggle }: { on: boolean; title: string; onToggle: () => void }) {
  return (
    <button type="button" className={`glass-heart${on ? " on" : ""}`} aria-pressed={on}
      aria-label={on ? `Remove ${title} from favorites` : `Add ${title} to favorites`} title={on ? "Favorite" : "Add to favorites"} onClick={onToggle}>
      <svg className="glass-heart-shadow" viewBox="0 0 24 24" aria-hidden="true"><path d={HEART} /></svg>
      <span className="glass-heart-bubble" aria-hidden="true" />
      <svg className="glass-heart-rim" viewBox="0 0 24 24" aria-hidden="true">
        <path d={HEART} className="glass-heart-edge" />
        <path d="M4.6 9.2c.1-1.9 1.4-3.3 3-3.5" className="glass-heart-shine" />
        <circle cx="15.8" cy="7.3" r=".9" className="glass-heart-glint" />
      </svg>
    </button>
  );
}
