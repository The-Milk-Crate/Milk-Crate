import { useMemo } from "react";
import { usePlayer } from "../lib/player";
import { useCatalog } from "../lib/catalog";
import { agoLabel, dayLabel, type Play } from "../lib/history";
import { sleeveSeed } from "../lib/sleeve";
import type { Track } from "../lib/types";
import { Sleeve } from "./ui";
import { fileArtist, useFileCover } from "../lib/fileTags";

/**
 * Songs you've played, newest first, grouped by day. Click one to play it now
 * (the rest of your queue stays after it). `limit` keeps it short in the queue panel.
 */
export function HistoryList({ limit, compact = false }: { limit?: number; compact?: boolean }) {
  const p = usePlayer();
  const c = useCatalog();
  const localById = useMemo(() => new Map(p.localTracks.map((t) => [t.id, t])), [p.localTracks]);
  const rows = useMemo(() => {
    const out: { play: Play; track: Track }[] = [];
    for (const play of p.history) {
      const track = c.trackById[play.trackId] ?? localById.get(play.trackId);
      if (track) out.push({ play, track }); // songs that were taken down are skipped
      if (limit && out.length >= limit) break;
    }
    return out;
  }, [p.history, c.trackById, localById, limit]);

  if (!rows.length) return <p className="caption muted">Nothing yet. Songs you play show up here.</p>;

  let day = "";
  return (
    <ol className={`history-list${compact ? " compact" : ""}`}>
      {rows.map(({ play, track: t }, i) => {
        const label = dayLabel(play.at);
        const header = label !== day ? (day = label) : null;
        const r = c.releaseById[t.releaseId];
        const artist = c.artistById[t.artistId]?.name ?? (fileArtist(t) || "Your Computer");
        return (
          <li key={`${play.at}-${t.id}-${i}`}>
            {header && <span className="catalog eyebrow history-day">{header}</span>}
            <button type="button" className="history-row" onClick={() => p.playNow(t)} aria-label={`Play ${t.title} by ${artist} now. Played ${label.toLowerCase()} ${agoLabel(play.at)}`}>
              <HistoryCover art={r?.art} coverKey={t.tags?.cover} seed={r ? sleeveSeed(r.title, artist) : t.title} size={compact ? 36 : 40} />
              <span className="history-text">
                <span className="history-title">{t.title}</span>
                <span className="caption muted history-sub">{[artist, compact ? null : r?.title].filter(Boolean).join(" · ")}</span>
              </span>
              <span className="caption muted numeral history-time">{agoLabel(play.at)}</span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

/** A song's cover: its album's, or the one saved from a file on your computer. */
export function HistoryCover({ art, coverKey, seed, size }: { art?: string; coverKey?: string; seed: string; size: number }) {
  const file = useFileCover(art ? undefined : coverKey);
  return <Sleeve src={art ?? file} seed={seed} style={{ width: size, flex: "none" }} />;
}
