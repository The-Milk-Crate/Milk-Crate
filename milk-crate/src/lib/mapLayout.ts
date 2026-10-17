/**
 * Map helpers shared by the Scenes screen: US state outlines (loaded on
 * demand), dot sizes, packing a town's dots together, and placing labels so
 * they never cover a dot or each other.
 */
import { feature, mesh } from "topojson-client";
import type { FeatureCollection, Geometry, MultiLineString } from "geojson";
import { STATE_NAMES, type Place } from "./geo";

export const STATE_BY_NAME = Object.fromEntries(Object.entries(STATE_NAMES).map(([code, name]) => [name, code]));

export interface StatesData { states: FeatureCollection<Geometry, { name: string }>; borders: MultiLineString }
let statesData: Promise<StatesData> | null = null;
export function loadStates() {
  statesData ??= import("us-atlas/states-10m.json").then((m) => {
    const topo = (m.default ?? m) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    return {
      states: feature(topo, topo.objects.states) as unknown as FeatureCollection<Geometry, { name: string }>,
      borders: mesh(topo, topo.objects.states, (a: unknown, b: unknown) => a !== b) as MultiLineString,
    };
  });
  return statesData;
}


/* ---------- layout: dot clusters and labels that don't collide ---------- */

/** Dot radius from how many ratings the artist's songs have: more ratings, bigger dot (area grows with the count). */
export function dotRadius(ratings: number, mode: "scene" | "national"): number {
  const [min, step, max] = mode === "scene" ? [5, 1.6, 15] : [3.2, 0.9, 8.5];
  return Math.min(max, min + step * Math.sqrt(Math.max(0, ratings)));
}

export interface Dot<T> { item: T; x: number; y: number; r: number }
export interface Cluster<T> {
  key: string; place: Place; cx: number; cy: number; R: number; dots: Dot<T>[];
  /** Set when the city is off the map and pinned to its edge: the direction it lies in (radians). */
  edge?: number;
}

/** Packs a city's dots tightly around it, biggest in the middle, none overlapping. */
export function packCluster<T>(items: { item: T; r: number }[], cx: number, cy: number, gap = 1.5): Dot<T>[] {
  const placed: Dot<T>[] = [];
  for (const { item, r } of [...items].sort((a, b) => b.r - a.r)) {
    if (!placed.length) {
      placed.push({ item, x: cx, y: cy, r });
      continue;
    }
    let best: Dot<T> | null = null;
    for (let d = 1; !best && d < 400; d += 1) {
      for (let k = 0; k < 36; k++) {
        const a = -Math.PI / 2 + (k / 36) * Math.PI * 2;
        const x = cx + Math.cos(a) * d;
        const y = cy + Math.sin(a) * d;
        if (placed.every((p) => Math.hypot(p.x - x, p.y - y) >= p.r + r + gap)) {
          best = { item, x, y, r };
          break;
        }
      }
    }
    placed.push(best ?? { item, x: cx, y: cy, r });
  }
  return placed;
}

export const enclose = (dots: { x: number; y: number; r: number }[], cx: number, cy: number) => Math.max(...dots.map((d) => Math.hypot(d.x - cx, d.y - cy) + d.r));

/** Nudges clusters of nearby cities apart until their dots don't overlap. */
export function separate<T>(clusters: Cluster<T>[], iterations = 60) {
  for (let it = 0; it < iterations; it++) {
    let moved = false;
    for (let i = 0; i < clusters.length; i++)
      for (let j = i + 1; j < clusters.length; j++) {
        const a = clusters[i], b = clusters[j];
        const dx = b.cx - a.cx, dy = b.cy - a.cy;
        const d = Math.hypot(dx, dy) || 0.01;
        const need = a.R + b.R + 3;
        if (d >= need) continue;
        const push = (need - d) / 2;
        const ux = dx / d, uy = dy / d;
        for (const [c, s] of [[a, -1], [b, 1]] as const) {
          c.cx += ux * push * s;
          c.cy += uy * push * s;
          for (const dot of c.dots) {
            dot.x += ux * push * s;
            dot.y += uy * push * s;
          }
        }
        moved = true;
      }
    if (!moved) break;
  }
}

interface Box { x: number; y: number; w: number; h: number }
const boxHitsCircle = (b: Box, x: number, y: number, r: number) => {
  const nx = Math.max(b.x, Math.min(x, b.x + b.w));
  const ny = Math.max(b.y, Math.min(y, b.y + b.h));
  return Math.hypot(nx - x, ny - y) < r;
};
const boxesHit = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/**
 * Puts each city's name next to its cluster (above, below, beside or on a
 * diagonal), picking the first spot that covers no dot and no other name.
 */
export function placeLabels(
  labels: { key: string; text: string; size: number; wide: boolean; cx: number; cy: number; R: number }[],
  circles: { x: number; y: number; r: number }[],
  width: number,
  height: number,
) {
  const out: { key: string; x: number; y: number; anchor: "start" | "middle" | "end"; box: Box }[] = [];
  for (const l of labels) {
    const w = l.text.length * l.size * (l.wide ? 0.66 : 0.56) + 4;
    const h = l.size + 4;
    const gap = 5;
    const { cx, cy, R } = l;
    const d = R / Math.SQRT2;
    const spots: { box: Box; anchor: "start" | "middle" | "end" }[] = [
      { box: { x: cx - w / 2, y: cy - R - gap - h, w, h }, anchor: "middle" },
      { box: { x: cx + R + gap, y: cy - h / 2, w, h }, anchor: "start" },
      { box: { x: cx - w / 2, y: cy + R + gap, w, h }, anchor: "middle" },
      { box: { x: cx - R - gap - w, y: cy - h / 2, w, h }, anchor: "end" },
      { box: { x: cx + d + gap, y: cy - d - gap - h, w, h }, anchor: "start" },
      { box: { x: cx + d + gap, y: cy + d + gap, w, h }, anchor: "start" },
      { box: { x: cx - d - gap - w, y: cy - d - gap - h, w, h }, anchor: "end" },
      { box: { x: cx - d - gap - w, y: cy + d + gap, w, h }, anchor: "end" },
    ];
    const cost = (b: Box) =>
      (b.x < 2 || b.y < 2 || b.x + b.w > width - 2 || b.y + b.h > height - 2 ? 1000 : 0) +
      circles.filter((c) => boxHitsCircle(b, c.x, c.y, c.r + 2)).length * 10 +
      out.filter((o) => boxesHit(b, o.box)).length * 10;
    const best = spots.reduce((a, b) => (cost(b.box) < cost(a.box) ? b : a));
    const bx = best.box;
    out.push({ key: l.key, box: bx, anchor: best.anchor, x: best.anchor === "start" ? bx.x + 2 : best.anchor === "end" ? bx.x + bx.w - 2 : bx.x + bx.w / 2, y: bx.y + bx.h - 4 });
  }
  return out;
}

