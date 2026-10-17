/**
 * Milk Crate UI primitives — the React/TypeScript versions of the components
 * in the Milk Crate design system. Class names match src/styles/components.css.
 */
import type { ButtonHTMLAttributes, CSSProperties, ReactNode } from "react";
import type { Rating } from "../lib/types";
import { sleeveDesign, sleeveSeed } from "../lib/sleeve";
import { useDownloadedTracks } from "../lib/downloads";

const cx = (...c: (string | false | undefined | null)[]) => c.filter(Boolean).join(" ");

/* ---------- Glyphs (solid transport set) ---------- */
export const MARK_PATH =
  "M14 11H50A2 2 0 0 1 52 13V17H12V13A2 2 0 0 1 14 11ZM10 20H54A6 6 0 0 1 60 26V56A6 6 0 0 1 54 62H10A6 6 0 0 1 4 56V26A6 6 0 0 1 10 20ZM12 26H20A2 2 0 0 1 22 28V36A2 2 0 0 1 20 38H12A2 2 0 0 1 10 36V28A2 2 0 0 1 12 26ZM12 44H20A2 2 0 0 1 22 46V54A2 2 0 0 1 20 56H12A2 2 0 0 1 10 54V46A2 2 0 0 1 12 44ZM28 26H36A2 2 0 0 1 38 28V36A2 2 0 0 1 36 38H28A2 2 0 0 1 26 36V28A2 2 0 0 1 28 26ZM28 44H36A2 2 0 0 1 38 46V54A2 2 0 0 1 36 56H28A2 2 0 0 1 26 54V46A2 2 0 0 1 28 44ZM44 26H52A2 2 0 0 1 54 28V36A2 2 0 0 1 52 38H44A2 2 0 0 1 42 36V28A2 2 0 0 1 44 26ZM44 44H52A2 2 0 0 1 54 46V54A2 2 0 0 1 52 56H44A2 2 0 0 1 42 54V46A2 2 0 0 1 44 44Z";

const G = ({ d, vb = "0 0 24 24", rule }: { d: string; vb?: string; rule?: "evenodd" }) => (
  <svg viewBox={vb} aria-hidden="true" fill="currentColor"><path d={d} fillRule={rule} /></svg>
);
export const Glyph = {
  play: () => <G d="M7 4.5v15a1 1 0 0 0 1.5.86l12.5-7.5a1 1 0 0 0 0-1.72L8.5 3.64A1 1 0 0 0 7 4.5Z" />,
  pause: () => <G d="M6.5 4h2A1.5 1.5 0 0 1 10 5.5v13A1.5 1.5 0 0 1 8.5 20h-2A1.5 1.5 0 0 1 5 18.5v-13A1.5 1.5 0 0 1 6.5 4Zm9 0h2A1.5 1.5 0 0 1 19 5.5v13a1.5 1.5 0 0 1-1.5 1.5h-2a1.5 1.5 0 0 1-1.5-1.5v-13A1.5 1.5 0 0 1 15.5 4Z" />,
  next: () => <G d="M4 5.2v13.6a1 1 0 0 0 1.55.83L15.5 13a1.2 1.2 0 0 0 0-2L5.55 4.37A1 1 0 0 0 4 5.2ZM18 4h1a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-1a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z" />,
  prev: () => <G d="M20 5.2v13.6a1 1 0 0 1-1.55.83L8.5 13a1.2 1.2 0 0 1 0-2l9.95-6.63A1 1 0 0 1 20 5.2ZM5 4h1a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z" />,
  star: () => <G d="M12 2.6l2.9 5.9 6.5.95-4.7 4.6 1.1 6.45L12 17.45 6.2 20.5l1.1-6.45-4.7-4.6 6.5-.95z" />,
  crate: () => <G d={MARK_PATH} vb="0 0 64 64" rule="evenodd" />,
};

/* ---------- Downloaded ---------- */
/** A small arrow-into-tray mark: this song (or every song on this album) plays without the internet. */
export function DownloadedMark({ label = "Downloaded", size = 14 }: { label?: string; size?: number }) {
  return (
    <span className="mc-downloaded" role="img" aria-label={label} title={`${label}: plays without the internet`}>
      <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden="true">
        <circle cx="8" cy="8" r="7.25" fill="currentColor" />
        <path d="M8 4.2v5.2M5.6 7.3 8 9.7l2.4-2.4M5 11.6h6" fill="none" stroke="var(--mc-downloaded-ink, var(--on-accent))" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
}

/** True when every one of these songs is downloaded. */
export function useAllDownloaded(trackIds?: string[]) {
  const dl = useDownloadedTracks();
  return !!trackIds?.length && trackIds.every((id) => dl[id]);
}

/* ---------- Button ---------- */
type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "quiet" | "ghost";
  size?: "md" | "sm";
  icon?: keyof typeof Glyph;
};
export function Button({ variant = "quiet", size = "md", icon, className, children, ...rest }: ButtonProps) {
  const Icon = icon ? Glyph[icon] : null;
  return (
    <button type="button" {...rest} className={cx("mc-btn", variant !== "quiet" && `mc-btn-${variant}`, size === "sm" && "mc-btn-sm", className)}>
      {Icon && <Icon />}
      {children}
    </button>
  );
}

export function PlayButton({ playing, size = "md", onClick }: { playing?: boolean; size?: "md" | "lg"; onClick?: () => void }) {
  return (
    <button type="button" className={cx("mc-play", size === "lg" && "mc-play-lg")} onClick={onClick} aria-label={playing ? "Pause" : "Play"}>
      {playing ? <Glyph.pause /> : <Glyph.play />}
    </button>
  );
}

/* ---------- Sticker ---------- */
export type StickerTone = "sticker" | "crate" | "dairy" | "accent" | "neutral";
export function Sticker({ tone = "sticker", children }: { tone?: StickerTone; children: ReactNode }) {
  return <span className={cx("mc-sticker", tone !== "sticker" && `mc-sticker-${tone}`)}>{children}</span>;
}

/* ---------- StarRating ---------- */
export function StarRating({ value = 0, onChange, size = 16 }: { value?: Rating; onChange?: (v: Rating) => void; size?: number }) {
  const readOnly = !onChange;
  return (
    <span className="mc-stars" role="group" aria-label={`Rating: ${value} of 5`} style={{ "--mc-star": `${size}px` } as CSSProperties}>
      {([1, 2, 3, 4, 5] as const).map((n) => (
        <button
          key={n}
          type="button"
          className={cx("mc-star", n <= value && "on")}
          disabled={readOnly}
          aria-label={`${n} star${n > 1 ? "s" : ""}`}
          aria-pressed={n === value}
          onClick={(e) => {
            e.stopPropagation();
            onChange?.(n === value ? 0 : n);
          }}
        >
          <Glyph.star />
        </button>
      ))}
    </span>
  );
}

/* ---------- Sleeve: generated art when an artist hasn't supplied any ---------- */
export function Sleeve({ src, seed = "milk crate", alt = "", style }: { src?: string; seed?: string; alt?: string; style?: CSSProperties }) {
  if (src) return <div className="mc-sleeve" style={style}><img src={src} alt={alt} /></div>;
  const { n, a, b, c, variant: v } = sleeveDesign(seed);
  const f = (k: string) => `mc-f-${k}`;
  return (
    <div className="mc-sleeve" style={style} role="img" aria-label={alt || "Cover art"}>
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        <rect className={f(a)} width="100" height="100" />
        {v === 0 && (<><circle className={f(b)} cx="64" cy="50" r="34" /><circle className={f(c)} cx="64" cy="50" r="10" /><circle className={f(a)} cx="64" cy="50" r="2" /><rect className={f(c)} width="38" height="100" /></>)}
        {v === 1 && (<>{[0, 1, 2, 3, 4].map((i) => <rect key={i} className={f(i % 2 ? b : c)} y={12 + i * 16} width={100 - i * 14} height="8" />)}<circle className={f(b)} cx="82" cy="82" r="10" /></>)}
        {v === 2 && (<><circle className={f(b)} cx="30" cy="70" r="52" /><circle className={f(a)} cx="30" cy="70" r="12" /><rect className={f(c)} x="62" y="10" width="28" height="28" rx="4" /></>)}
        {v === 3 && [0, 1, 2].flatMap((r) => [0, 1, 2].map((q) => <rect key={`${r}${q}`} className={f((r + q + n) % 4 === 0 ? c : b)} x={14 + q * 26} y={14 + r * 26} width="20" height="20" rx="3" />))}
      </svg>
    </div>
  );
}

/* ---------- ReleaseCard ---------- */
export function ReleaseCard(props: {
  title: string; artist: string; place?: string; year?: number; art?: string;
  sticker?: string; stickerTone?: StickerTone; onOpen?: () => void;
  /** Shows a play button over the cover. */
  onPlay?: () => void;
  /** Sleeve seed; defaults to title + artist. Pass it when `artist` isn't the artist's name. */
  seed?: string;
  /** The release's songs: shows the downloaded mark when every one is downloaded. */
  trackIds?: string[];
}) {
  const meta = [props.artist, props.place, props.year].filter(Boolean).join(" · ");
  const downloaded = useAllDownloaded(props.trackIds);
  return (
    <div className="mc-card-wrap">
      <a
        className="mc-card"
        href="#"
        onClick={(e) => {
          e.preventDefault();
          props.onOpen?.();
        }}
      >
        <div className="mc-card-art">
          <Sleeve src={props.art} seed={props.seed ?? sleeveSeed(props.title, props.artist)} alt={`${props.title} cover`} />
          {props.sticker && <Sticker tone={props.stickerTone}>{props.sticker}</Sticker>}
        </div>
        <div>
          <div className="mc-card-title">{props.title}{downloaded && <> <DownloadedMark label="Album downloaded" size={13} /></>}</div>
          <div className="mc-card-meta">{meta}</div>
        </div>
      </a>
      {props.onPlay && (
        <button type="button" className="mc-play mc-card-play" aria-label={`Play ${props.title}`} onClick={props.onPlay}>
          <Glyph.play />
        </button>
      )}
    </div>
  );
}

/** Average star rating from everyone on Milk Crate (read-only). Albums are rated; songs are favorited. */
export function AverageRating({ value, size = 14 }: { value?: number; size?: number }) {
  if (!value) return <span className="mc-avg mc-avg-none" title="Not rated yet" style={{ "--mc-star": `${size}px` } as CSSProperties}>Not rated</span>;
  const pct = Math.max(0, Math.min(100, (value / 5) * 100));
  return (
    <span className="mc-avg" role="img" aria-label={`Average rating ${value.toFixed(1)} of 5`} title={`Average from listeners: ${value.toFixed(1)}`}
      style={{ "--mc-star": `${size}px` } as CSSProperties}>
      <span className="mc-avg-stars" aria-hidden="true">
        <span className="mc-avg-base">{[1, 2, 3, 4, 5].map((n) => <Glyph.star key={n} />)}</span>
        <span className="mc-avg-fill" style={{ width: `${pct}%` }}>{[1, 2, 3, 4, 5].map((n) => <Glyph.star key={n} />)}</span>
      </span>
      <span className="mc-avg-num" aria-hidden="true">{value.toFixed(1)}</span>
    </span>
  );
}

/* ---------- Favorites and streams ---------- */

/** "12", "1,204", "12.4K", "1.2M". */
export function streamsLabel(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1).replace(/\.0$/, "")}M`;
  if (n >= 10_000) return `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1).replace(/\.0$/, "")}K`;
  return n.toLocaleString("en-US");
}

/** The heart on a song: adds it to (or takes it out of) your favorites. */
export function FavoriteButton({ on, title, onToggle, size = 16 }: { on: boolean; title: string; onToggle: () => void; size?: number }) {
  return (
    <button type="button" className={cx("mc-fav", on && "on")} aria-pressed={on} aria-label={on ? `Remove ${title} from favorites` : `Favorite ${title}`}
      title={on ? "In your favorites" : "Add to favorites"}
      onClick={(e) => { e.stopPropagation(); onToggle(); }} onKeyDown={(e) => e.stopPropagation()}>
      <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" fill={on ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinejoin="round">
        <path d="M12 20.5s-7.5-4.6-9.2-9.3C1.6 7.9 3.8 4.5 7.3 4.5c2 0 3.6 1.1 4.7 2.7 1.1-1.6 2.7-2.7 4.7-2.7 3.5 0 5.7 3.4 4.5 6.7C19.5 15.9 12 20.5 12 20.5Z" />
      </svg>
    </button>
  );
}

/* ---------- TrackRow ---------- */
export function TrackRow(props: {
  index: number; title: string; artist?: string; duration: string;
  /** Show a heart: filled when the song is one of your favorites. */
  favorite?: boolean;
  onFavorite?: () => void;
  /** Show how many times the song has been streamed (artist pages). */
  streams?: number;
  /** This row is the song that's loaded in the player. */
  playing?: boolean;
  /** The loaded song is paused (shows a play button instead of pause). */
  paused?: boolean;
  onPlay?: () => void;
  /** Pause / resume the loaded song. */
  onToggle?: () => void;
  /** Extra controls before the duration (add to playlist, remove…). */
  actions?: ReactNode;
  /** The song's id: shows the downloaded mark when it's downloaded. */
  trackId?: string;
}) {
  const downloaded = useDownloadedTracks()[props.trackId ?? ""];
  return (
    <div
      className={cx("mc-track", props.playing && "playing")}
      role="button"
      tabIndex={0}
      onClick={props.onPlay}
      onKeyDown={(e) => e.key === "Enter" && props.onPlay?.()}
    >
      <span className="mc-track-num">
        {props.playing ? (
          <button type="button" className="mc-track-toggle" aria-label={props.paused ? `Play ${props.title}` : `Pause ${props.title}`}
            onClick={(e) => { e.stopPropagation(); props.onToggle?.(); }} onKeyDown={(e) => e.stopPropagation()}>
            {props.paused ? <Glyph.play /> : <Glyph.pause />}
          </button>
        ) : (
          <>
            <span className="mc-track-index">{String(props.index).padStart(2, "0")}</span>
            <span className="mc-track-hover-play" aria-hidden="true"><Glyph.play /></span>
          </>
        )}
      </span>
      <span className="mc-track-text">
        <span className="mc-track-title">{props.title}{downloaded && <> <DownloadedMark size={12} /></>}</span>
        {props.artist && <span className="mc-track-artist">{props.artist}</span>}
      </span>
      <span className="mc-track-meta">
        {props.streams !== undefined && <span className="mc-track-streams" title="Streams on Milk Crate">{streamsLabel(props.streams)}</span>}
        {props.onFavorite && <FavoriteButton on={!!props.favorite} title={props.title} onToggle={props.onFavorite} />}
      </span>
      {props.actions && <span className="mc-track-actions" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>{props.actions}</span>}
      <span className="mc-track-dur">{props.duration}</span>
    </div>
  );
}

/* ---------- Logo ---------- */
/**
 * The Milk Crate lockup: crate mark + wordmark in Archivo Black caps.
 * Both are drawn in the accent color, so the logo is lavender by default and
 * shifts with the album that's playing (see src/lib/useAlbumAccent.ts).
 */
export function Logo({ className }: { className?: string }) {
  return (
    <span className={cx("mc-logo", className)} aria-label="Milk Crate" role="img">
      <svg viewBox="0 0 64 64" width="28" height="28" aria-hidden="true"><path d={MARK_PATH} fillRule="evenodd" fill="currentColor" /></svg>
      <span aria-hidden="true" className="mc-wordmark">Milk Crate</span>
    </span>
  );
}
