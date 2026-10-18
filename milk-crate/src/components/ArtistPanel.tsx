import type { CSSProperties } from "react";
import type { Go } from "../App";
import type { Artist } from "../lib/types";
import { useCatalog } from "../lib/catalog";
import { usePlayer } from "../lib/player";
import { sleeveSeed } from "../lib/sleeve";
import { ReleaseCard } from "./ui";
import { ArtistBanner } from "./ArtistBanner";
import { FollowButton } from "./ArtistCard";

/**
 * An artist as a mini artist page: a rounded panel with their own banner,
 * name lettering and colors on top, and their releases fitted underneath.
 * "wide" fits 5 releases across (then "All N releases"); "small" fits 4.
 */
export function ArtistPanel({ artist: a, go, size = "wide", line }: { artist: Artist; go: Go; size?: "wide" | "small"; line?: string }) {
  const c = useCatalog();
  const p = usePlayer();
  const releases = c.releases.filter((r) => r.artistId === a.id);
  const fits = size === "wide" ? 5 : 4;
  const shown = releases.length > fits ? releases.slice(0, fits - (size === "wide" ? 0 : 1)) : releases;
  const more = releases.length - shown.length;
  const open = () => go({ name: "artist", artistId: a.id });
  return (
    <article className={`artist-panel is-${size}`} style={{ "--panel-edge": a.accent } as CSSProperties} aria-label={a.name}>
      <div className="artist-panel-banner">
        <ArtistBanner artist={a} fill headingLevel={2} />
        <button type="button" className="artist-panel-open" onClick={open} aria-label={`Open ${a.name}'s page`} />
        <div className="artist-panel-follow"><FollowButton artist={a} small /></div>
      </div>
      {line && <p className="caption muted artist-panel-line">{line}</p>}
      {releases.length ? (
        <div className="artist-panel-releases" style={{ gridTemplateColumns: `repeat(${size === "wide" ? 6 : 4}, minmax(0, 1fr))` }}>
          {shown.map((r) => (
            <ReleaseCard key={r.id} trackIds={r.trackIds} title={r.title} artist={r.kind} year={r.year} art={r.art} seed={sleeveSeed(r.title, a.name)}
              onOpen={() => go({ name: "album", releaseId: r.id })}
              onPlay={r.trackIds.length ? () => p.playQueue(r.trackIds.map((id) => c.trackById[id]).filter(Boolean)) : undefined} />
          ))}
          {more > 0 && (
            <button type="button" className="artist-panel-more" onClick={open}>All {releases.length} releases</button>
          )}
        </div>
      ) : (
        <p className="caption muted artist-panel-empty">No releases yet.</p>
      )}
    </article>
  );
}
