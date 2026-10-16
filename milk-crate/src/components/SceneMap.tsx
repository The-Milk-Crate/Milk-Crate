import { useEffect, useMemo, useState } from "react";
import { geoAlbersUsa, geoCircle, geoMercator, geoPath, type GeoProjection } from "d3-geo";
import { feature, mesh } from "topojson-client";
import type { Feature, FeatureCollection, Geometry, MultiLineString } from "geojson";
import type { ArtistPlace as MapArtist } from "../lib/location";
import { SCENE_RADIUS_MI, STATE_NAMES, miles, placeKey, type Place, type Scene } from "../lib/geo";

const W = 640;
const H = 400;
const STATE_BY_NAME = Object.fromEntries(Object.entries(STATE_NAMES).map(([code, name]) => [name, code]));

interface StatesData { states: FeatureCollection<Geometry, { name: string }>; borders: MultiLineString }
let statesData: Promise<StatesData> | null = null;
function loadStates() {
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

interface Dot<T> { item: T; x: number; y: number; r: number }
interface Cluster<T> {
  key: string; place: Place; cx: number; cy: number; R: number; dots: Dot<T>[];
  /** Set when the city is off the map and pinned to its edge: the direction it lies in (radians). */
  edge?: number;
}
/** Miles from home that the scene map frames; cities farther away are pinned to its edge. */
const FRAME_MI = 60;
const EDGE = 8;
/** On the national map, cities closer than this (px) share one cluster. */
const MERGE_PX = 22;
const ARROWS = ["→", "↘", "↓", "↙", "←", "↖", "↑", "↗"];
const arrowFor = (rad: number) => ARROWS[((Math.round(rad / (Math.PI / 4)) % 8) + 8) % 8];

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

/** A city's name; off-map cities get an arrow pointing their way. */
const labelText = (c: { place: Place; edge?: number }) => (c.edge === undefined ? c.place.name : `${c.place.name} ${arrowFor(c.edge)}`);

const enclose = (dots: { x: number; y: number; r: number }[], cx: number, cy: number) => Math.max(...dots.map((d) => Math.hypot(d.x - cx, d.y - cy) + d.r));

/** Nudges clusters of nearby cities apart until their dots don't overlap. */
function separate<T>(clusters: Cluster<T>[], iterations = 60) {
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

/**
 * A real map. "scene": your scene's area (the 35-mile circle plus the cities
 * in it where artists are). "national": the whole country. Only cities with
 * published artists appear. Each band is a dot in its profile color, sized by
 * how many ratings its songs have, packed around its city; city names sit
 * beside the dots, never under them.
 */
export function SceneMap(props: {
  mode: "scene" | "national";
  scene: Scene | null;
  artists: MapArtist[];
  /** Ratings per artist (all their songs), for dot size. */
  ratings: Record<string, number>;
  hovered: string | null;
  onHover: (artistId: string | null) => void;
  onOpen: (artistId: string) => void;
}) {
  const { mode, scene, artists, ratings, hovered, onHover, onOpen } = props;
  const [data, setData] = useState<StatesData | null>(null);
  useEffect(() => {
    loadStates().then(setData).catch(() => setData(null));
  }, []);

  const projection = useMemo<GeoProjection | null>(() => {
    if (!data) return null;
    if (mode === "national" || !scene) return geoAlbersUsa().fitExtent([[12, 12], [W - 12, H - 12]], data.states) as unknown as GeoProjection;
    // Frame your area (the scene circle and towns just outside it). Farther cities in the scene
    // are pinned to the map's edge, pointing their way, so the map stays zoomed in where you live.
    const radius = geoCircle().center([scene.home.lng, scene.home.lat]).radius(SCENE_RADIUS_MI / 69.05)();
    const pts = artists
      .filter((a) => miles(scene.home, a.place) <= FRAME_MI)
      .map((a) => ({ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [a.place.lng, a.place.lat] } }));
    const frame = { type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: radius }, ...pts] } as FeatureCollection;
    return geoMercator().fitExtent([[56, 52], [W - 56, H - 40]], frame);
  }, [data, mode, scene, artists]);

  const layout = useMemo(() => {
    if (!projection) return null;
    const at = (p: { lat: number; lng: number }) => projection([p.lng, p.lat]) as [number, number] | null;
    const byCity = new Map<string, MapArtist[]>();
    for (const a of artists) byCity.set(placeKey(a.place), [...(byCity.get(placeKey(a.place)) ?? []), a]);
    if (mode === "national") {
      // Zoomed out, neighboring cities are a few pixels apart: share one cluster instead of shoving apart.
      const groups: { xy: [number, number]; key: string; items: MapArtist[] }[] = [];
      for (const [key, group] of [...byCity].sort((a, b) => b[1].length - a[1].length)) {
        const xy = at(group[0].place);
        if (!xy) continue;
        const near = groups.find((g) => Math.hypot(g.xy[0] - xy[0], g.xy[1] - xy[1]) < MERGE_PX);
        if (near) near.items.push(...group);
        else groups.push({ xy, key, items: [...group] });
      }
      byCity.clear();
      for (const g of groups) byCity.set(g.key, g.items);
    }
    const clusters: Cluster<MapArtist>[] = [];
    const homeXY = scene ? at(scene.home) : null;
    for (const [key, group] of byCity) {
      let xy = at(group[0].place);
      if (!xy) continue;
      const items = group.map((a) => ({ item: a, r: dotRadius(ratings[a.artist.id] ?? 0, mode) }));
      let edge: Cluster<MapArtist>["edge"];
      if (mode === "scene" && homeXY && (xy[0] < EDGE || xy[0] > W - EDGE || xy[1] < EDGE || xy[1] > H - EDGE)) {
        // Off the map: pin it to the edge along the line from home.
        const R0 = enclose(packCluster(items, 0, 0, 2), 0, 0);
        const pad = R0 + 10;
        const dx = xy[0] - homeXY[0], dy = xy[1] - homeXY[1];
        const t = Math.min(dx ? ((dx > 0 ? W - pad : pad) - homeXY[0]) / dx : Infinity, dy ? ((dy > 0 ? H - pad : pad) - homeXY[1]) / dy : Infinity);
        xy = [homeXY[0] + dx * t, homeXY[1] + dy * t];
        edge = Math.atan2(dy, dx);
      }
      const dots = packCluster(items, xy[0], xy[1], mode === "scene" ? 2 : 1);
      clusters.push({ key, place: group[0].place, cx: xy[0], cy: xy[1], R: enclose(dots, xy[0], xy[1]), dots, edge });
    }
    if (mode === "scene") separate(clusters);
    const homeKey = scene ? placeKey(scene.home) : "";
    const ordered = [...clusters].sort((a, b) => Number(b.key === homeKey) - Number(a.key === homeKey) || b.dots.length - a.dots.length || b.place.pop - a.place.pop);
    const circles = clusters.flatMap((c) => c.dots.map((d) => ({ x: d.x, y: d.y, r: d.r })));
    const labels =
      mode === "scene"
        ? placeLabels(
            ordered.map((c) => ({ key: c.key, text: labelText(c), size: c.key === homeKey ? 15 : 13, wide: true, cx: c.cx, cy: c.cy, R: c.R })),
            circles, W, H,
          )
        : [];
    return { clusters, labels, homeKey, homeXY };
  }, [projection, artists, ratings, mode, scene]);

  if (!data || !projection || !layout) return <div className="scene-map-loading muted">Loading map…</div>;
  const path = geoPath(projection);
  const homeState = scene?.home.state;
  const dots = layout.clusters.flatMap((c) => c.dots);
  const hoveredDot = dots.find((d) => d.item.artist.id === hovered);
  const nameOf = new Map(layout.clusters.map((c) => [c.key, labelText(c)]));

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="scene-map" role="group"
      aria-label={mode === "scene" && scene ? `Map of the scene around ${scene.home.name}` : "Map of Milk Crate artists across the country"}>
      <rect width={W} height={H} fill="var(--ground-sunken)" />
      <g aria-hidden="true">
        {data.states.features.map((f: Feature<Geometry, { name: string }>) => (
          <path key={f.properties.name} d={path(f) ?? undefined}
            fill={STATE_BY_NAME[f.properties.name] === homeState && mode === "scene" ? "var(--ground-raised)" : "var(--ground)"} />
        ))}
        <path d={path(data.borders) ?? undefined} fill="none" stroke="var(--line-strong)" strokeWidth={mode === "scene" ? 1.5 : 0.8} />
        {mode === "scene" && scene && (
          <path d={path(geoCircle().center([scene.home.lng, scene.home.lat]).radius(SCENE_RADIUS_MI / 69.05)()) ?? undefined}
            fill="var(--accent)" fillOpacity="0.08" stroke="var(--accent)" strokeOpacity="0.6" strokeDasharray="4 4" />
        )}
        {mode === "national" && layout.homeXY && (() => {
          // Ring your area: around the cluster your city is in, or your city if it has no artists yet.
          const [hx, hy] = layout.homeXY;
          const mine = layout.clusters.find((c) => Math.hypot(c.cx - hx, c.cy - hy) < MERGE_PX);
          return <circle cx={mine?.cx ?? hx} cy={mine?.cy ?? hy} r={(mine?.R ?? 6) + 5} fill="none" stroke="var(--accent)" strokeWidth="2" strokeDasharray="3 3" />;
        })()}
        {layout.clusters.filter((c) => c.edge !== undefined).map((c) => (
          <circle key={c.key} cx={c.cx} cy={c.cy} r={c.R + 4} fill="none" stroke="var(--ink-muted)" strokeOpacity="0.6" strokeDasharray="2 3" />
        ))}
        {layout.labels.map((l) => (
          <text key={l.key} x={l.x} y={l.y} textAnchor={l.anchor} fill="var(--ink)" fontFamily="var(--font-display)"
            fontSize={l.key === layout.homeKey ? 15 : 13} stroke="var(--ground-sunken)" strokeWidth="3" paintOrder="stroke">
            {nameOf.get(l.key)}
          </text>
        ))}
      </g>
      {dots.map(({ item: { artist: a, place }, x, y, r }) => (
        <g key={a.id} role="link" tabIndex={0} aria-label={`${a.name}, ${place.name}, ${place.state}`} style={{ cursor: "pointer", outline: "none" }}
          onClick={() => onOpen(a.id)} onKeyDown={(e) => e.key === "Enter" && onOpen(a.id)}
          onMouseEnter={() => onHover(a.id)} onMouseLeave={() => onHover(null)} onFocus={() => onHover(a.id)} onBlur={() => onHover(null)}>
          <circle cx={x} cy={y} r={hovered === a.id ? r + 2 : r} fill={a.accent} stroke="var(--ink)" strokeOpacity="0.35" strokeWidth={mode === "scene" ? 1.25 : 1} style={{ transition: "r .15s ease-out" }} />
          {hovered === a.id && <circle cx={x} cy={y} r={r + 6} fill="none" stroke="var(--focus)" strokeWidth="2" />}
        </g>
      ))}
      {hoveredDot && (() => {
        const { artist: a, place } = hoveredDot.item;
        const n = ratings[a.id] ?? 0;
        const text = `${a.name} · ${place.name} · ${n ? `${n} ${n === 1 ? "rating" : "ratings"}` : "no ratings yet"}`;
        const w = text.length * 7.1 + 30;
        const left = Math.min(Math.max(hoveredDot.x - w / 2, 4), W - 4 - w);
        const top = hoveredDot.y - hoveredDot.r - 40 < 4 ? hoveredDot.y + hoveredDot.r + 12 : hoveredDot.y - hoveredDot.r - 40;
        return (
          <g pointerEvents="none" aria-hidden="true">
            <rect x={left} y={top} width={w} height="26" rx="6" fill="var(--ground)" stroke="var(--line)" />
            <circle cx={left + 13} cy={top + 13} r="5" fill={a.accent} />
            <text x={left + 24} y={top + 17.5} fill="var(--ink)" fontFamily="var(--font-sans)" fontWeight="600" fontSize="13">{text}</text>
          </g>
        );
      })()}
    </svg>
  );
}
