import { Disc3, X } from "lucide-react";
import type { Go } from "../App";
import { setRip, useRip } from "../lib/ripSession";

/**
 * In the bottom-right corner while you're away from the CD ripper: how a rip is going, and a note
 * when it's done (open the album, or close the note).
 */
export function RipNotice({ go }: { go: Go }) {
  const [shown] = useRip("shown");
  const [ripping] = useRip("ripping");
  const [progress] = useRip("progress");
  const [notice] = useRip("notice");
  const [draft] = useRip("draft");
  if (shown || (!ripping && !notice)) return null;

  if (ripping) {
    const pct = Math.round((progress?.overall ?? 0) * 100);
    return (
      <div className="rip-notice" role="status">
        <Disc3 className="spin-slow" size={20} strokeWidth={1.75} aria-hidden="true" />
        <button type="button" className="rip-notice-text" onClick={() => go({ name: "computer" })} title="Go to the CD ripper">
          <strong>Ripping {draft?.album || "your CD"}</strong>
          <span className="caption muted">{progress ? `Song ${progress.at} of ${progress.of} · ${pct}%` : "Starting…"}</span>
          <span className="rip-notice-bar" aria-hidden="true"><span style={{ width: `${pct}%` }} /></span>
        </button>
      </div>
    );
  }
  const n = notice!;
  return (
    <div className="rip-notice is-done" role="status">
      <Disc3 size={20} strokeWidth={1.75} aria-hidden="true" />
      <button type="button" className="rip-notice-text" onClick={() => { setRip({ notice: null }); go(n.albumKey ? { name: "computer", album: n.albumKey } : { name: "computer" }); }}>
        <strong>{n.album} is ripped</strong>
        <span className="caption muted">
          {n.count} {n.count === 1 ? "song" : "songs"} saved{n.skipped.length ? `, ${n.skipped.length} skipped` : ""}. Open it in Your Computer.
        </span>
      </button>
      <button type="button" className="mc-icon-btn" aria-label="Close" onClick={() => setRip({ notice: null })}><X size={16} aria-hidden="true" /></button>
    </div>
  );
}
