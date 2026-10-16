import { useEffect, useMemo, useState } from "react";
import { geoAlbersUsa, geoCircle, geoMercator, geoPath, type GeoProjection } from "d3-geo";
import { feature, mesh } from "topojson-client";
import type { Feature, FeatureCollection, Geometry, MultiLineString } from "geojson";
import type { ArtistPlace as MapArtist } from "../lib/location";
import { SCENE_RADIUS_MI, STATE_NAMES, placeKey, type Place, type Scene } from "../lib/geo";

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


/** Spreads several dots around one city so each band stays clickable. */
function spread<T>(items: T[], x: number, y: number): { item: T; x: number; y: number }[] {
  if (items.length === 1) return [{ item: items[0], x, y }];
  return items.map((item, i) => {
    const ring = i < 6 ? 0 : 1;
    const inRing = ring === 0 ? Math.min(items.length, 6) : items.length - 6;
    const idx = ring === 0 ? i : i - 6;
    const r = ring === 0 ? 11 : 21;
    const a = -Math.PI / 2 + (idx / inRing) * Math.PI * 2;
    return { item, x: x + Math.cos(a) * r, y: y + Math.sin(a) * r };
  });
}

/**
 * A real map. "scene": the home city, the scene radius, nearby towns and the
 * state's larger cities. "national": the whole country. Every band is a dot
 * in its own profile color at its home city.
 */
export function SceneMap(props: {
  mode: "scene" | "national";
  scene: Scene | null;
  artists: MapArtist[];
  hovered: string | null;
  onHover: (artistId: string | null) => void;
  onOpen: (artistId: string) => void;
}) {
  const { mode, scene, artists, hovered, onHover, onOpen } = props;
  const [data, setData] = useState<StatesData | null>(null);
  useEffect(() => {
    loadStates().then(setData).catch(() => setData(null));
  }, []);

  const projection = useMemo<GeoProjection | null>(() => {
    if (!data) return null;
    if (mode === "national" || !scene) return geoAlbersUsa().fitExtent([[12, 12], [W - 12, H - 12]], data.states) as unknown as GeoProjection;
    const radius = geoCircle().center([scene.home.lng, scene.home.lat]).radius(SCENE_RADIUS_MI / 69.05)();
    const pts = scene.anchors.map((a) => ({ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [a.lng, a.lat] } }));
    const frame = { type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: radius }, ...pts] } as FeatureCollection;
    return geoMercator().fitExtent([[40, 44], [W - 40, H - 28]], frame);
  }, [data, mode, scene]);

  if (!data || !projection) return <div className="scene-map-loading muted">Loading map…</div>;
  const path = geoPath(projection);
  const at = (p: { lat: number; lng: number }) => projection([p.lng, p.lat]) as [number, number] | null;
  const homeState = scene?.home.state;

  // Cities to label (scene view): home, the biggest nearby towns, and the state's larger cities, skipping crowded labels.
  const labels: { place: Place; x: number; y: number; kind: "home" | "near" | "anchor" }[] = [];
  if (mode === "scene" && scene) {
    const candidates: [Place, "home" | "near" | "anchor"][] = [
      [scene.home, "home"],
      ...scene.anchors.map((p) => [p, "anchor"] as [Place, "anchor"]),
      ...scene.nearby.slice(0, 8).map((p) => [p, "near"] as [Place, "near"]),
    ];
    for (const [place, kind] of candidates) {
      const xy = at(place);
      if (!xy || xy[0] < 0 || xy[0] > W || xy[1] < 0 || xy[1] > H) continue;
      if (labels.some((l) => Math.abs(l.x - xy[0]) < 70 && Math.abs(l.y - xy[1]) < 18)) continue;
      labels.push({ place, x: xy[0], y: xy[1], kind });
    }
  }

  // Bands, grouped by city.
  const byCity = new Map<string, MapArtist[]>();
  for (const a of artists) {
    const k = placeKey(a.place);
    byCity.set(k, [...(byCity.get(k) ?? []), a]);
  }
  const dots = [...byCity.values()].flatMap((group) => {
    const xy = at(group[0].place);
    return xy ? spread(group, xy[0], xy[1]) : [];
  });
  const hoveredDot = dots.find((d) => d.item.artist.id === hovered);
  const homeXY = scene ? at(scene.home) : null;

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
            fill="var(--dairy)" fillOpacity="0.1" stroke="var(--dairy)" strokeOpacity="0.5" strokeDasharray="4 4" />
        )}
        {labels.map((l) => (
          <g key={placeKey(l.place)}>
            <circle cx={l.x} cy={l.y} r={l.kind === "home" ? 5 : 3} fill={l.kind === "home" ? "var(--dairy)" : "var(--ink-muted)"} />
            <text x={l.x} y={l.y - (l.kind === "home" ? 12 : 9)} textAnchor="middle" fill={l.kind === "near" ? "var(--ink-muted)" : "var(--ink)"}
              fontFamily={l.kind === "near" ? "var(--font-sans)" : "var(--font-display)"} fontSize={l.kind === "home" ? 15 : l.kind === "anchor" ? 13 : 11}
              stroke="var(--ground-sunken)" strokeWidth="3" paintOrder="stroke">{l.place.name}</text>
          </g>
        ))}
        {mode === "national" && homeXY && (
          <circle cx={homeXY[0]} cy={homeXY[1]} r="9" fill="none" stroke="var(--dairy)" strokeWidth="2" />
        )}
      </g>
      {dots.map(({ item: { artist: a, place }, x, y }) => (
        <g key={a.id} role="link" tabIndex={0} aria-label={`${a.name}, ${place.name}, ${place.state}`} style={{ cursor: "pointer", outline: "none" }}
          onClick={() => onOpen(a.id)} onKeyDown={(e) => e.key === "Enter" && onOpen(a.id)}
          onMouseEnter={() => onHover(a.id)} onMouseLeave={() => onHover(null)} onFocus={() => onHover(a.id)} onBlur={() => onHover(null)}>
          <circle cx={x} cy={y} r={hovered === a.id ? 9 : mode === "national" ? 5 : 7} fill={a.accent} stroke="var(--ground-sunken)" strokeWidth="2" style={{ transition: "r .15s ease-out" }} />
          {hovered === a.id && <circle cx={x} cy={y} r="13" fill="none" stroke="var(--focus)" strokeWidth="2" />}
        </g>
      ))}
      {hoveredDot && (() => {
        const { artist: a, place } = hoveredDot.item;
        const text = `${a.name} · ${place.name}`;
        const w = text.length * 7.4 + 30;
        const left = Math.min(Math.max(hoveredDot.x - w / 2, 4), W - 4 - w);
        const top = hoveredDot.y - 44 < 4 ? hoveredDot.y + 18 : hoveredDot.y - 44;
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
