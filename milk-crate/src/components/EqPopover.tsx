import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { usePlayer } from "../lib/player";
import { EQ_BANDS, EQ_MAX_DB, EQ_PRESETS, FLAT } from "../lib/audioOut";

/** One band: an upright track that fills from 0 dB toward the knob. Drag it, use the arrow keys, or double-click for 0. */
function EqSlider({ label, value, disabled, onChange }: { label: string; value: number; disabled: boolean; onChange: (db: number) => void }) {
  const track = useRef<HTMLDivElement>(null);
  const clamp = (v: number) => Math.max(-EQ_MAX_DB, Math.min(EQ_MAX_DB, Math.round(v)));
  const fromPointer = (y: number) => {
    const r = track.current!.getBoundingClientRect();
    return clamp(EQ_MAX_DB - ((y - r.top) / r.height) * EQ_MAX_DB * 2);
  };
  const down = (e: PointerEvent<HTMLDivElement>) => {
    if (disabled || e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    e.currentTarget.focus();
    onChange(fromPointer(e.clientY));
  };
  const move = (e: PointerEvent<HTMLDivElement>) => {
    if (!disabled && e.currentTarget.hasPointerCapture(e.pointerId)) onChange(fromPointer(e.clientY));
  };
  const key = (e: KeyboardEvent) => {
    if (disabled) return;
    const step = ({ ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1, PageUp: 3, PageDown: -3 } as Record<string, number>)[e.key];
    if (step !== undefined) { e.preventDefault(); onChange(clamp(value + step)); }
    else if (e.key === "Home") { e.preventDefault(); onChange(EQ_MAX_DB); }
    else if (e.key === "End") { e.preventDefault(); onChange(-EQ_MAX_DB); }
  };
  const at = 50 - (value / EQ_MAX_DB) * 50; // % from the top
  return (
    <div className="eqp-band">
      <div ref={track} className="eqp-track" role="slider" tabIndex={disabled ? -1 : 0} aria-label={`${label} Hz`}
        aria-orientation="vertical" aria-valuemin={-EQ_MAX_DB} aria-valuemax={EQ_MAX_DB} aria-valuenow={value}
        aria-valuetext={`${value > 0 ? "+" : ""}${value} decibels`} aria-disabled={disabled}
        onPointerDown={down} onPointerMove={move} onKeyDown={key} onDoubleClick={() => !disabled && onChange(0)}>
        <span className="eqp-zero" />
        <span className="eqp-fill" style={{ top: `${Math.min(at, 50)}%`, height: `${Math.abs(at - 50)}%` }} />
        <span className="eqp-knob" style={{ top: `${at}%` }} />
      </div>
      <span className="eqp-hz">{label}</span>
    </div>
  );
}

/**
 * The equalizer, popped out above the player bar from its EQ button: on/off, presets, six bands.
 * Closes with ✕, Escape, a click anywhere else, or the EQ button again.
 */
export function EqPopover({ anchor, onClose, onMore }: { anchor: RefObject<HTMLElement | null>; onClose: () => void; onMore: () => void }) {
  const p = usePlayer();
  const box = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ right: number; bottom: number; origin: string } | null>(null);
  const [closing, setClosing] = useState(false);
  const preset = Object.entries(EQ_PRESETS).find(([, g]) => g.every((v, i) => v === p.eqGains[i]))?.[0];
  const setBand = (i: number, db: number) => p.setEqGains(p.eqGains.map((g, j) => (j === i ? db : g)));

  // Sits just above the player bar, its right edge in line with the bar's controls, and grows out of the EQ button.
  useLayoutEffect(() => {
    const measure = () => {
      const bar = document.querySelector(".shell-player")?.getBoundingClientRect();
      const btn = anchor.current?.getBoundingClientRect();
      if (!bar || !btn) return;
      const right = Math.max(12, window.innerWidth - bar.right + 16);
      const width = Math.min(440, window.innerWidth - 24);
      const x = width - (window.innerWidth - right - (btn.left + btn.width / 2));
      setPlace({ right, bottom: window.innerHeight - bar.top + 22, origin: `${Math.max(0, Math.min(width, x))}px 100%` });
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

  // Focus moves into the pop-out when it opens.
  useEffect(() => { box.current?.querySelector<HTMLElement>("[role=switch]")?.focus({ preventScroll: true }); }, []);

  if (!place) return null;
  return createPortal(
    <div ref={box} className={`eq-pop${closing ? " is-closing" : ""}`} role="dialog" aria-label="Equalizer"
      style={{ right: place.right, bottom: place.bottom, transformOrigin: place.origin }}>
      <div className="eq-pop-head">
        <h2 className="display-md">Equalizer</h2>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <button type="button" role="switch" aria-checked={p.eqOn} aria-label={p.eqOn ? "Equalizer on" : "Equalizer off"} className="switch" style={{ padding: 6 }} onClick={() => p.setEqOn(!p.eqOn)}>
            <span className="switch-track" aria-hidden="true"><span className="switch-thumb" /></span>
          </button>
          <button type="button" className="mc-icon-btn" aria-label="Close" onClick={close}><X size={18} strokeWidth={1.75} aria-hidden="true" /></button>
        </div>
      </div>
      <div className={`eq-pop-body${p.eqOn ? "" : " is-off"}`}>
        <div role="group" aria-label="Presets" className="eq-pop-presets">
          {Object.keys(EQ_PRESETS).map((name) => (
            <button key={name} type="button" className="chip" aria-pressed={preset === name} disabled={!p.eqOn} onClick={() => p.setEqGains(EQ_PRESETS[name])}>{name}</button>
          ))}
        </div>
        <div className="eq-pop-bands">
          <div className="eq-pop-scale" aria-hidden="true"><span>+{EQ_MAX_DB}</span><span>0</span><span>−{EQ_MAX_DB}</span></div>
          {EQ_BANDS.map((b, i) => (
            <EqSlider key={b.hz} label={b.label} value={p.eqGains[i] ?? 0} disabled={!p.eqOn} onChange={(db) => setBand(i, db)} />
          ))}
        </div>
      </div>
      <div className="eq-pop-foot">
        <button type="button" className="link-btn caption" disabled={!p.eqOn} onClick={() => p.setEqGains(FLAT)}>Reset to flat</button>
        <button type="button" className="link-btn caption muted" onClick={() => { onClose(); onMore(); }}>More sound settings ›</button>
      </div>
    </div>,
    document.body,
  );
}
