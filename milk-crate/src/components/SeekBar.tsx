import { useState, type PointerEvent } from "react";
import { usePlayer } from "../lib/player";
import { formatTime } from "../lib/format";

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

/**
 * The seek bar (scrubber): elapsed time, a track you can click anywhere on,
 * and a round handle you can drag. Home/End go to the start/end (the arrow
 * keys don't move it). While dragging, the time shows where you'll land; the song
 * jumps there when you let go.
 */
/** Half the oval handle's length (it's 26px long; see .mc-progress-thumb). */
const HALF = 13;

export function SeekBar({ className }: { className?: string }) {
  const p = usePlayer();
  const [drag, setDrag] = useState<number | null>(null);
  const ready = !!p.current && p.duration > 0;
  const frac = drag ?? (p.duration ? clamp01(p.elapsed / p.duration) : 0);
  const shown = drag !== null ? drag * p.duration : p.elapsed;
  // The oval handle stays inside the bar: its middle runs from HALF px in at the start to HALF px in at the end.
  const at = (e: PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return clamp01((e.clientX - r.left - HALF) / (r.width - 2 * HALF));
  };
  const pos = `calc(${HALF}px + (100% - ${2 * HALF}px) * ${frac})`;

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
          const to = ({ Home: 0, End: p.duration - 1 } as Record<string, number>)[e.key];
          if (to === undefined) return;
          e.preventDefault();
          p.seek(to / p.duration);
        }}
      >
        <div className="mc-progress-rail">
          <div className="mc-progress-fill" style={{ width: pos }} />
        </div>
        {ready && <div className="mc-progress-thumb" style={{ left: pos }} />}
      </div>
      <span className="mc-progress-time">{formatTime(p.duration)}</span>
    </div>
  );
}
