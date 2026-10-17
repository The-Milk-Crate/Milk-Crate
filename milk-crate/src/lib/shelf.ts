/**
 * Your Shelf: the records, tapes and CDs you own, shown the way they sit at home.
 * A section only shows when you have something in it.
 */
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type WheelEvent } from "react";
import type { ShelfFormat } from "../App";
import type { PhysicalFormat } from "./types";
import { load, save } from "./storage";

export const SHELF_SECTIONS: { id: ShelfFormat; format: PhysicalFormat; label: string; one: string }[] = [
  { id: "vinyl", format: "LP", label: "Vinyl", one: "record" },
  { id: "45s", format: "7in", label: "’45s", one: "45" },
  { id: "cds", format: "CD", label: "CDs", one: "CD" },
  { id: "cassettes", format: "Cassette", label: "Cassettes", one: "tape" },
];

/** The sections you have something in, in shelf order. */
export function ownedSections(formats: PhysicalFormat[]) {
  const have = new Set(formats);
  return SHELF_SECTIONS.filter((s) => have.has(s.format));
}

/** A steady color for a spine or label that has no artwork color of its own. */
export function spineColor(seed: string): string {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  const hue = (h >>> 0) % 360;
  const light = 34 + ((h >>> 9) % 18);
  return `hsl(${hue} 38% ${light}%)`;
}

/* ---------- Flipping: wheel, drag, arrow keys ---------- */

/**
 * Flip through `count` things one at a time with the mouse wheel or trackpad,
 * by dragging, or with the arrow keys. `step` is how far a drag goes per item.
 */
export function useFlipper(count: number, { step = 46, axis = "y" as "x" | "y", onFlip }: { step?: number; axis?: "x" | "y"; onFlip?: () => void } = {}) {
  const [index, setIndexRaw] = useState(0);
  const wheel = useRef(0);
  const drag = useRef<{ start: number; from: number; moved: boolean } | null>(null);
  const justDragged = useRef(false);
  const clamp = useCallback((i: number) => Math.max(0, Math.min(count - 1, i)), [count]);
  const setIndex = useCallback((i: number | ((i: number) => number)) => {
    setIndexRaw((cur) => clamp(typeof i === "function" ? i(cur) : i));
  }, [clamp]);
  useEffect(() => { setIndexRaw((i) => clamp(i)); }, [clamp]);
  // A tick each time it moves (not when it first shows).
  const flipRef = useRef(onFlip);
  flipRef.current = onFlip;
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    flipRef.current?.();
  }, [index]);

  const onWheel = (e: WheelEvent) => {
    const d = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
    wheel.current += d;
    if (Math.abs(wheel.current) < 60) return;
    const n = Math.trunc(wheel.current / 60);
    wheel.current -= n * 60;
    setIndex((i) => i + n);
  };
  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    drag.current = { start: axis === "y" ? e.clientY : e.clientX, from: index, moved: false };
  };
  const onPointerMove = (e: PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const delta = d.start - (axis === "y" ? e.clientY : e.clientX);
    if (!d.moved && Math.abs(delta) < 8) return;
    if (!d.moved) (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    d.moved = true;
    // Records: drag down to pull the next one toward you. Side to side: drag left for the next one.
    setIndex(d.from + Math.round(delta / step) * (axis === "y" ? -1 : 1));
  };
  const onPointerUp = () => {
    if (drag.current?.moved) {
      justDragged.current = true;
      setTimeout(() => { justDragged.current = false; }, 0);
    }
    drag.current = null;
  };
  /** True right after a drag, so the click that ends it doesn't also pull something out. */
  const wasDrag = () => justDragged.current;
  const onKeyDown = (e: KeyboardEvent) => {
    const to = ({ ArrowRight: 1, ArrowDown: 1, PageDown: 5, ArrowLeft: -1, ArrowUp: -1, PageUp: -5 } as Record<string, number>)[e.key];
    if (e.key === "Home") { e.preventDefault(); setIndex(0); return; }
    if (e.key === "End") { e.preventDefault(); setIndex(count - 1); return; }
    if (to === undefined) return;
    e.preventDefault();
    setIndex((i) => i + to);
  };
  return { index, setIndex, wasDrag, handlers: { onWheel, onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp, onKeyDown } };
}

/* ---------- A soft sound when you flip ---------- */

const SOUND_KEY = "mc.shelfSounds";
export const shelfSoundsOn = () => load(SOUND_KEY, true);
export const setShelfSounds = (on: boolean) => save(SOUND_KEY, on);

let ctx: AudioContext | null = null;
/**
 * A quiet, short tick: card sleeves for records, a plastic clack for CDs, a
 * light knock for tapes. Made on the spot (no sound files). Very quiet on purpose.
 */
export function flipSound(kind: "sleeve" | "case" | "tape") {
  if (!shelfSoundsOn()) return;
  try {
    ctx ??= new AudioContext();
    const len = kind === "sleeve" ? 0.05 : 0.03;
    const buf = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * len), ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / data.length, kind === "case" ? 6 : 3);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const filter = ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.value = kind === "sleeve" ? 1400 : kind === "case" ? 3200 : 2100;
    filter.Q.value = kind === "case" ? 4 : 1.2;
    const gain = ctx.createGain();
    gain.gain.value = 0.07;
    src.connect(filter).connect(gain).connect(ctx.destination);
    src.start();
  } catch {
    /* no sound: fine */
  }
}

/* ---------- Sorting ---------- */

export type ShelfSort = "az" | "year";

/** A–Z: by artist, then title. Year: newest first (ones with no year last), then A–Z. */
export function sortShelf<T extends { artist: string; title: string; year?: number }>(items: T[], by: ShelfSort): T[] {
  const name = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true });
  const az = (a: T, b: T) => name(a.artist, b.artist) || name(a.title, b.title);
  return [...items].sort(by === "year" ? (a, b) => (b.year ?? -Infinity) - (a.year ?? -Infinity) || az(a, b) : az);
}
