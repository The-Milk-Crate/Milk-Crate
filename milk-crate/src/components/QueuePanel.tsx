import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, GripVertical, X } from "lucide-react";
import { usePlayer } from "../lib/player";
import { useCatalog } from "../lib/catalog";
import { sleeveSeed } from "../lib/sleeve";
import { formatTime } from "../lib/format";
import type { Track } from "../lib/types";
import { HistoryCover, HistoryList } from "./HistoryList";
import { fileArtist } from "../lib/fileTags";
import { Button } from "./ui";

/**
 * What's playing and what's next. Drag songs (or use the arrows) to reorder,
 * remove them, or jump to one. The History tab shows what played before; click
 * a song to hear it again. Opens from the player bar; Esc closes it.
 */
export function QueuePanel({ onClose }: { onClose: () => void }) {
  const p = usePlayer();
  const c = useCatalog();
  const [drag, setDrag] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const [view, setView] = useState<"queue" | "history">("queue");
  const panel = useRef<HTMLElement>(null);

  useEffect(() => {
    panel.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const upNext = p.queue.map((t, i) => ({ t, i })).slice(p.index + 1);
  const meta = (t: Track) => {
    const r = c.releaseById[t.releaseId];
    const artist = c.artistById[t.artistId]?.name ?? (fileArtist(t) || "Your Computer");
    return { art: r?.art, seed: r ? sleeveSeed(r.title, artist) : t.title, artist };
  };

  const row = (t: Track, i: number, now = false) => {
    const m = meta(t);
    return (
      <li key={`${i}-${t.id}`} className={`queue-row${now ? " now" : ""}${over === i && drag !== null && drag !== i ? " drop" : ""}`}
        draggable={!now} onDragStart={() => setDrag(i)} onDragEnd={() => { setDrag(null); setOver(null); }}
        onDragOver={(e) => { if (drag !== null && !now) { e.preventDefault(); setOver(i); } }}
        onDrop={(e) => { e.preventDefault(); if (drag !== null) p.moveInQueue(drag, i); setDrag(null); setOver(null); }}>
        {!now && <GripVertical className="queue-grip" size={16} strokeWidth={1.75} aria-hidden="true" />}
        <HistoryCover art={m.art} coverKey={t.tags?.cover} seed={m.seed} size={40} />
        <button type="button" className="queue-title" onClick={() => !now && p.jumpTo(i)} aria-label={now ? `${t.title}, playing now` : `Play ${t.title} now`} disabled={now}>
          <span className="queue-name">{t.title}</span>
          <span className="caption muted">{m.artist} · {formatTime(t.duration)}</span>
        </button>
        {!now && (
          <span className="queue-actions">
            <button type="button" className="mc-icon-btn" aria-label={`Move ${t.title} up`} disabled={i <= p.index + 1} onClick={() => p.moveInQueue(i, i - 1)}><ArrowUp size={16} strokeWidth={1.75} aria-hidden="true" /></button>
            <button type="button" className="mc-icon-btn" aria-label={`Move ${t.title} down`} disabled={i >= p.queue.length - 1} onClick={() => p.moveInQueue(i, i + 1)}><ArrowDown size={16} strokeWidth={1.75} aria-hidden="true" /></button>
            <button type="button" className="mc-icon-btn" aria-label={`Remove ${t.title} from the queue`} onClick={() => p.removeFromQueue(i)}><X size={16} strokeWidth={1.75} aria-hidden="true" /></button>
          </span>
        )}
      </li>
    );
  };

  return (
    <aside ref={panel} tabIndex={-1} className="queue-panel" aria-label="Queue">
      <div className="queue-head">
        <div role="tablist" aria-label="Queue or history" className="queue-tabs">
          <button type="button" role="tab" aria-selected={view === "queue"} onClick={() => setView("queue")}>Queue</button>
          <button type="button" role="tab" aria-selected={view === "history"} onClick={() => setView("history")}>History</button>
        </div>
        <button type="button" className="mc-icon-btn" aria-label="Close the queue" onClick={onClose}><X size={18} strokeWidth={1.75} aria-hidden="true" /></button>
      </div>
      {view === "history" ? (
        <HistoryList limit={50} compact />
      ) : p.current ? (
        <>
          <span className="catalog eyebrow">Now playing</span>
          <ul className="queue-list">{row(p.current, p.index, true)}</ul>
          <div className="queue-sub">
            <span className="catalog eyebrow">{p.radio ? `Up next · from ${p.radio}` : `Up next${upNext.length ? ` · ${upNext.length}` : ""}`}</span>
            {upNext.length > 0 && <Button size="sm" variant="ghost" onClick={p.clearUpNext}>Clear</Button>}
          </div>
          {upNext.length ? (
            <ul className="queue-list">{upNext.map(({ t, i }) => row(t, i))}</ul>
          ) : (
            <p className="caption muted">Nothing after this one. Use "Play next" or "Add to queue" from any song's menu.</p>
          )}
          {p.radio && (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 8 }}>
              <p className="caption muted" style={{ margin: 0 }}>{p.radio} keeps adding songs as it goes.</p>
              <Button size="sm" onClick={p.stopRadio}>Stop the radio</Button>
            </div>
          )}
          {!p.radio && p.repeat === "all" && p.queue.length > 1 && <p className="caption muted">Then it starts again from the top.</p>}
        </>
      ) : (
        <p className="muted">Nothing playing. Pick a record.</p>
      )}
    </aside>
  );
}
