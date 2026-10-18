import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Volume1, Volume2, VolumeX } from "lucide-react";
import { usePlayer } from "../lib/player";

/** Below this window width the volume slider folds into its speaker button (src/components/PlayerBar.tsx). */
export const VOLUME_FOLD_PX = 1100;

export function VolumeIcon({ size = 18 }: { size?: number }) {
  const p = usePlayer();
  const Icon = p.muted || p.volume === 0 ? VolumeX : p.volume < 0.5 ? Volume1 : Volume2;
  return <Icon size={size} strokeWidth={1.75} aria-hidden="true" />;
}

/**
 * The volume, popped out above its speaker button when the window is too narrow for the slider:
 * an upright slider (drag, scroll, arrow keys), the level, and mute. Closes like the equalizer.
 */
export function VolumePopover({ anchor, onClose }: { anchor: RefObject<HTMLElement | null>; onClose: () => void }) {
  const p = usePlayer();
  const box = useRef<HTMLDivElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ left: number; bottom: number } | null>(null);
  const [closing, setClosing] = useState(false);
  const level = Math.round((p.muted ? 0 : p.volume) * 100);
  const set = (v: number) => p.setVolume(Math.max(0, Math.min(100, Math.round(v))) / 100);

  useLayoutEffect(() => {
    const measure = () => {
      const bar = document.querySelector(".shell-player")?.getBoundingClientRect();
      const btn = anchor.current?.getBoundingClientRect();
      if (!bar || !btn) return;
      const W = 64;
      setPlace({ left: Math.min(window.innerWidth - W - 8, btn.left + btn.width / 2 - W / 2), bottom: window.innerHeight - bar.top + 10 });
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [anchor]);

  const close = useCallback(() => {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return onClose();
    setClosing(true);
    setTimeout(onClose, 150);
  }, [onClose]);

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); close(); } };
    const onDown = (e: globalThis.PointerEvent) => {
      const t = e.target as Node;
      if (box.current?.contains(t) || anchor.current?.contains(t)) return;
      close();
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointerdown", onDown, true);
    return () => { window.removeEventListener("keydown", onKey, true); window.removeEventListener("pointerdown", onDown, true); };
  }, [close, anchor]);

  useEffect(() => { track.current?.focus({ preventScroll: true }); }, [place !== null]); // eslint-disable-line react-hooks/exhaustive-deps

  // Scrolling over the pop-out turns it up or down.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => { e.preventDefault(); set(level + (e.deltaY < 0 ? 5 : -5)); };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  });

  const fromPointer = (y: number) => {
    const r = track.current!.getBoundingClientRect();
    return 100 - ((y - r.top) / r.height) * 100;
  };
  const down = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    set(fromPointer(e.clientY));
  };
  const move = (e: PointerEvent<HTMLDivElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) set(fromPointer(e.clientY));
  };
  const key = (e: KeyboardEvent) => {
    const step = ({ ArrowUp: 5, ArrowRight: 5, ArrowDown: -5, ArrowLeft: -5, PageUp: 20, PageDown: -20 } as Record<string, number>)[e.key];
    if (step !== undefined) { e.preventDefault(); set(level + step); }
    else if (e.key === "Home") { e.preventDefault(); set(100); }
    else if (e.key === "End") { e.preventDefault(); set(0); }
  };

  if (!place) return null;
  return createPortal(
    <div ref={box} className={`eq-pop vol-pop${closing ? " is-closing" : ""}`} role="dialog" aria-label="Volume"
      style={{ left: place.left, bottom: place.bottom }}>
      <span className="vol-pop-level numeral" aria-hidden="true">{level}</span>
      <div ref={track} className="vol-pop-track" role="slider" tabIndex={0} aria-label="Volume" aria-orientation="vertical"
        aria-valuemin={0} aria-valuemax={100} aria-valuenow={level} aria-valuetext={`${level}%`}
        onPointerDown={down} onPointerMove={move} onKeyDown={key}>
        <span className="vol-pop-fill" style={{ height: `${level}%` }} />
        <span className="vol-pop-knob" style={{ bottom: `${level}%` }} />
      </div>
      <button type="button" className="mc-icon-btn" aria-label={p.muted ? "Unmute" : "Mute"} aria-pressed={p.muted} onClick={() => p.setMuted(!p.muted)}>
        <VolumeIcon />
      </button>
    </div>,
    document.body,
  );
}

/** True while the window is narrower than `px`. */
export function useNarrow(px: number) {
  const q = `(max-width: ${px - 1}px)`;
  const [narrow, setNarrow] = useState(() => typeof matchMedia !== "undefined" && matchMedia(q).matches);
  useEffect(() => {
    const m = matchMedia(q);
    const on = () => setNarrow(m.matches);
    on();
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, [q]);
  return narrow;
}
