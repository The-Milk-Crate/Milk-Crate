import { useRef, useState } from "react";
import { usePlayer } from "../lib/player";
import { EqPopover } from "./EqPopover";
import { useCatalog } from "../lib/catalog";
import { sleeveSeed } from "../lib/sleeve";
import { ListMusic, Maximize2, Repeat, Repeat1, Shuffle } from "lucide-react";
import { VOLUME_FOLD_PX, VolumeIcon, VolumePopover, useNarrow } from "./VolumePopover";
import type { Go } from "../App";
import { SeekBar } from "./SeekBar";
import { Glyph, PlayButton, Sleeve } from "./ui";
import { fileArtist, useFileCover } from "../lib/fileTags";

/** The persistent player along the bottom of the window. */
export function PlayerBar({ go, onImmersive, queueOpen, onQueue }: { go: Go; onImmersive: () => void; queueOpen: boolean; onQueue: () => void }) {
  const p = usePlayer();
  const [eqOpen, setEqOpen] = useState(false);
  const eqBtn = useRef<HTMLButtonElement>(null);
  const [volOpen, setVolOpen] = useState(false);
  const volBtn = useRef<HTMLButtonElement>(null);
  const folded = useNarrow(VOLUME_FOLD_PX);
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
            {/* The cover nearly fills the bar; the heart sits above the song's name. */}
            <div className="mc-player-cover">
              <button type="button" className="mc-player-art" aria-label="Immersive mode" title="Immersive mode" onClick={onImmersive}>
                <Sleeve src={release?.art ?? fileCover} seed={release ? sleeveSeed(release.title, artist) : t.title} />
              </button>
            </div>
            <div className="mc-player-text">
              <HeartButton on={p.isFavorite(t.id)} title={t.title} onToggle={() => p.toggleFavorite(t.id)} />
              <div className="mc-player-title-row">
                <span className="mc-track-title">{t.title}</span>
              </div>
              <div className="mc-track-artist">{artist}</div>
              {p.loadError && <div className="caption mc-player-error" role="status" title={p.loadError}>Couldn't play this song</div>}
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
          {folded ? (
            <button ref={volBtn} type="button" className={`mc-icon-btn${volOpen ? " on" : ""}`} aria-label={`Volume (${Math.round((p.muted ? 0 : p.volume) * 100)}%)`}
              aria-expanded={volOpen} aria-haspopup="dialog" title="Volume" onClick={() => setVolOpen((o) => !o)}>
              <VolumeIcon />
            </button>
          ) : (
            <>
              <button type="button" className="mc-icon-btn" aria-label={p.muted ? "Unmute" : "Mute"} aria-pressed={p.muted} onClick={() => p.setMuted(!p.muted)}>
                <VolumeIcon />
              </button>
              <input type="range" className="volume-slider mc-range" min={0} max={100} step={1} aria-label="Volume"
                value={Math.round((p.muted ? 0 : p.volume) * 100)} onChange={(e) => p.setVolume(Number(e.target.value) / 100)}
                style={{ "--v": p.muted ? 0 : p.volume } as React.CSSProperties} />
            </>
          )}
          {folded && volOpen && <VolumePopover anchor={volBtn} onClose={() => setVolOpen(false)} />}
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

/** Favorite: just a heart above the song's name, an outline until it's a favorite, then filled with the accent. */
function HeartButton({ on, title, onToggle }: { on: boolean; title: string; onToggle: () => void }) {
  return (
    <button type="button" className={`mc-player-heart${on ? " on" : ""}`} aria-pressed={on}
      aria-label={on ? `Remove ${title} from favorites` : `Add ${title} to favorites`} title={on ? "Favorite" : "Add to favorites"} onClick={onToggle}>
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d={HEART} /></svg>
    </button>
  );
}
