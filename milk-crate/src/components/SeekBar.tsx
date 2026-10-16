import { useState, type PointerEvent } from "react";
import { usePlayer } from "../lib/player";
import { formatTime } from "../lib/format";

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

/**
 * The seek bar (scrubber): elapsed time, a track you can click anywhere on,
 * and an oval handle you can drag. Arrow keys jump 5 seconds, Home/End go to
 * the start/end. While dragging, the time shows where you'll land; the song
 * jumps there when you let go.
 */
export function SeekBar({ className }: { className?: string }) {
  const p = usePlayer();
  const [drag, setDrag] = useState<number | null>(null);
  const ready = !!p.current && p.duration > 0;
  const frac = drag ?? (p.duration ? clamp01(p.elapsed / p.duration) : 0);
  const shown = drag !== null ? drag * p.duration : p.elapsed;
  const at = (e: PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return clamp01((e.clientX - r.left) / r.width);
  };

  return (
    <div className={`mc-progress${className ? ` ${className}` : ""}`}>
      <span className="mc-progress-time" style={{ textAlign: "right" }}>{formatTime(shown)}</span>
      <div
        className={`mc-progress-track${drag !== null ? " dragging" : ""}${ready ? "" : " is-idle"}`}
        role="slider"
        tabIndex={ready ? 0 : -1}
        aria-label="Seek"
        aria-disabled={!ready}
        aria-valuemin={0}
        aria-valuemax={Math.round(p.duration)}
        aria-valuenow={Math.round(shown)}
        aria-valuetext={`${formatTime(shown)} of ${formatTime(p.duration)}`}
        onPointerDown={(e) => {
          if (!ready || e.button !== 0) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          setDrag(at(e));
        }}
        onPointerMove={(e) => drag !== null && setDrag(at(e))}
        onPointerUp={(e) => {
          if (drag === null) return;
          p.seek(at(e));
          setDrag(null);
        }}
        onPointerCancel={() => setDrag(null)}
        onKeyDown={(e) => {
          if (!ready) return;
          const to = { ArrowRight: p.elapsed + 5, ArrowUp: p.elapsed + 5, ArrowLeft: p.elapsed - 5, ArrowDown: p.elapsed - 5, Home: 0, End: p.duration - 1 }[e.key];
          if (to === undefined) return;
          e.preventDefault();
          p.seek(to / p.duration);
        }}
      >
        <div className="mc-progress-rail">
          <div className="mc-progress-fill" style={{ width: `${frac * 100}%` }} />
        </div>
        {ready && <div className="mc-progress-thumb" style={{ left: `${frac * 100}%` }} />}
      </div>
      <span className="mc-progress-time">{formatTime(p.duration)}</span>
    </div>
  );
}
