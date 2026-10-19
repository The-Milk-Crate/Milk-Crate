import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Bluetooth, Cast, Check, Headphones, Monitor, Speaker, Usb, Volume2, X } from "lucide-react";
import { chooseOutput, showOutputNames, useOutputs, type OutputKind } from "../lib/outputs";
import { Button } from "./ui";

const ICONS: Record<OutputKind, typeof Speaker> = { bluetooth: Bluetooth, headphones: Headphones, usb: Usb, hdmi: Monitor, airplay: Cast, builtin: Speaker, other: Volume2 };
export const outputIcon = (k: OutputKind) => ICONS[k] ?? Volume2;

/**
 * Where the sound plays, popped out above the player bar from its speaker button: the computer's
 * speakers, Bluetooth, headphones, a USB DAC… Closes with ✕, Escape, or a click anywhere else.
 */
export function OutputPopover({ anchor, onClose }: { anchor: RefObject<HTMLElement | null>; onClose: () => void }) {
  const o = useOutputs(true);
  const box = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ right: number; bottom: number; origin: string } | null>(null);
  const [closing, setClosing] = useState(false);
  const mac = o.mode === "system";

  useLayoutEffect(() => {
    const measure = () => {
      const bar = document.querySelector(".shell-player")?.getBoundingClientRect();
      const btn = anchor.current?.getBoundingClientRect();
      if (!bar || !btn) return;
      const right = Math.max(12, window.innerWidth - bar.right + 16);
      const width = Math.min(360, window.innerWidth - 24);
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
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); close(); } };
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (box.current?.contains(t) || anchor.current?.contains(t)) return;
      close();
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointerdown", onDown, true);
    return () => { window.removeEventListener("keydown", onKey, true); window.removeEventListener("pointerdown", onDown, true); };
  }, [close, anchor]);

  useEffect(() => { box.current?.querySelector<HTMLElement>("[aria-checked=true], .out-item")?.focus({ preventScroll: true }); }, [place]);

  if (!place) return null;
  return createPortal(
    <div ref={box} className={`eq-pop out-pop${closing ? " is-closing" : ""}`} role="dialog" aria-label="Play sound on"
      style={{ right: place.right, bottom: place.bottom, transformOrigin: place.origin }}>
      <div className="eq-pop-head">
        <h2 className="display-md">Play on</h2>
        <button type="button" className="mc-icon-btn" aria-label="Close" onClick={close}><X size={18} strokeWidth={1.75} aria-hidden="true" /></button>
      </div>
      <div role="radiogroup" aria-label="Sound output" className="out-list">
        {o.outputs.map((d) => {
          const Icon = d.id === "" ? Speaker : outputIcon(d.kind);
          return (
            <button key={d.id || "default"} type="button" role="radio" aria-checked={d.current} className={`out-item${d.current ? " is-current" : ""}`}
              onClick={() => void chooseOutput(d.id)}>
              <Icon size={18} strokeWidth={1.75} aria-hidden="true" />
              <span className="out-name">
                {d.id === "" && !mac ? <>Same as Windows{d.name && <span className="caption muted">{d.name}</span>}</> : d.name}
              </span>
              {d.current && <Check size={16} aria-hidden="true" />}
            </button>
          );
        })}
        {!o.outputs.length && <p className="caption muted">No sound outputs found.</p>}
      </div>
      {o.needsNames && (
        <div className="out-note">
          <span className="caption muted">To list your speakers and Bluetooth devices by name, Milk Crate needs to see your sound devices. It doesn't record anything.</span>
          <Button size="sm" onClick={() => void showOutputNames()}>Show my devices</Button>
        </div>
      )}
      {o.error && <p className="form-error" role="alert">{o.error}</p>}
      <p className="caption muted out-foot">
        {mac ? "Switches your Mac's sound output, the same as Control Center. Bluetooth devices show up once they're connected."
          : "Only Milk Crate plays there; the rest of your computer stays as it is. Bluetooth devices show up once they're paired and connected."}
      </p>
    </div>,
    document.body,
  );
}
