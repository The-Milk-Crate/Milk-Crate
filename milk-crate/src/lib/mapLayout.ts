/**
 * Map helpers shared by the Scenes screen: state and province outlines for each
 * country (loaded on demand), dot sizes, packing a town's dots together, and
 * placing labels so they never cover a dot or each other.
 */
import { feature, mesh } from "topojson-client";
import { geoArea } from "d3-geo";
import type { FeatureCollection, Geometry, MultiLineString } from "geojson";
import { STATE_NAMES, type Country, type Place } from "./geo";

export const STATE_BY_NAME = Object.fromEntries(Object.entries(STATE_NAMES).map(([code, name]) => [name, code]));

export interface RegionProps { name: string; code: string; country: Country }
export interface StatesData { states: FeatureCollection<Geometry, RegionProps>; borders: MultiLineString }

/* eslint-disable @typescript-eslint/no-explicit-any */
const fromTopo = (topo: any, object: any, props: (p: any) => RegionProps): StatesData => {
  const fc = feature(topo, object) as unknown as FeatureCollection<Geometry, any>;
  for (const f of fc.features) {
    f.properties = props(f.properties ?? {});
    rewind(f);
  }
  return { states: fc as FeatureCollection<Geometry, RegionProps>, borders: mesh(topo, object, (a: unknown, b: unknown) => a !== b) as MultiLineString };
};
/**
 * d3 draws a shape's outline clockwise; drawn the other way round, a shape means "the whole
 * world except this". Some map data winds the other way, so any shape bigger than half the
 * globe is turned around.
 */
function rewind(f: any) {
  if (geoArea(f) <= 2 * Math.PI) return;
  const g = f.geometry;
  if (g.type === "Polygon") g.coordinates = g.coordinates.map((ring: number[][]) => [...ring].reverse());
  else if (g.type === "MultiPolygon") g.coordinates = g.coordinates.map((poly: number[][][]) => poly.map((ring) => [...ring].reverse()));
  // A multipolygon whose parts are wound differently: fix each part on its own.
  if (g.type === "MultiPolygon" && geoArea(f) > 2 * Math.PI)
    g.coordinates = g.coordinates.map((poly: number[][][]) => {
      const part = { type: "Polygon", coordinates: poly };
      return geoArea(part as any) > 2 * Math.PI ? poly.map((ring) => [...ring].reverse()) : poly;
    });
}

const LOADERS: Record<Country, () => Promise<StatesData>> = {
  // US states from us-atlas; Canada and Australia from Natural Earth (scripts/build-regions.mjs).
  US: () => import("us-atlas/states-10m.json").then((m) => {
    const topo = (m.default ?? m) as any;
    return fromTopo(topo, topo.objects.states, (p) => ({ name: p.name, code: STATE_BY_NAME[p.name] ?? p.name, country: "US" }));
  }),
  CA: () => import("../data/regions-ca.json").then((m) => {
    const topo = (m.default ?? m) as any;
    return fromTopo(topo, topo.objects.regions, (p) => ({ name: p.name, code: p.code, country: "CA" }));
  }),
  AU: () => import("../data/regions-au.json").then((m) => {
    const topo = (m.default ?? m) as any;
    return fromTopo(topo, topo.objects.regions, (p) => ({ name: p.name, code: p.code, country: "AU" }));
  }),
};
/* eslint-enable @typescript-eslint/no-explicit-any */

const loaded: Partial<Record<Country, Promise<StatesData>>> = {};
/** One country's states, provinces or territories, and the lines between them. */
export function loadRegions(country: Country = "US") {
  return (loaded[country] ??= LOADERS[country]().catch((e) => {
    delete loaded[country];
    throw e;
  }));
}
/** The US states (kept for older callers). */
export const loadStates = () => loadRegions("US");

/** Every country's regions together, for close-up maps near a border (Detroit and Windsor). */
export async function loadAllRegions(): Promise<StatesData> {
  const all = await Promise.all((["US", "CA", "AU"] as Country[]).map((c) => loadRegions(c)));
  return {
    states: { type: "FeatureCollection", features: all.flatMap((d) => d.states.features) },
    borders: { type: "MultiLineString", coordinates: all.flatMap((d) => d.borders.coordinates) },
  };
}

/** County lines (only the borders between counties), for the close-up town map. Loaded on demand. */
let countyLines: Promise<MultiLineString> | null = null;
export function loadCountyLines() {
  countyLines ??= import("us-atlas/counties-10m.json").then((m) => {
    const topo = (m.default ?? m) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    return mesh(topo, topo.objects.counties, (a: unknown, b: unknown) => a !== b) as MultiLineString;
  });
  return countyLines;
}


/* ---------- layout: dot clusters and labels that don't collide ---------- */

/** Dot radius from how many times the artist's songs have been streamed: more streams, bigger dot. */
export function dotRadius(streams: number, mode: "scene" | "national"): number {
  const [min, step, max] = mode === "scene" ? [5, 2.5, 15] : [3.2, 1.3, 8.5];
  return Math.min(max, min + step * Math.log10(1 + Math.max(0, streams)));
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

