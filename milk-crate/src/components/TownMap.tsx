import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { geoMercator, geoPath, type GeoProjection } from "d3-geo";
import type { Geometry, MultiLineString, Position } from "geojson";
import type { Go } from "../App";
import { useCatalog } from "../lib/catalog";
import { useLocation } from "../lib/location";
import { COUNTRY_NAMES, placeKey, regionName, type Place } from "../lib/geo";
import { loadAllRegions, loadCountyLines, type StatesData } from "../lib/mapLayout";
import type { Bin } from "../lib/bins";
import type { Artist } from "../lib/types";

/** The frame never gets shorter than this (px), so a small window scrolls rather than squashing the map. */
const MIN_FRAME_PX = 2 * 136 + 40;
/** The town's circle, in map units. The map zooms so this covers MAX_RING_MI or less, staying inside the state. */
const R = 136;
const MAX_RING_MI = 9;
const MIN_RING_MI = 3;
const RING_FONT = 4.6;
/** Other towns get a name on the map from this size up (towns with artists always do). */
const LABEL_MIN_POP = 8000;

interface Spot { artist: Artist; streams: number; x: number; y: number; r: number }
interface Label { key: string; text: string; x: number; y: number; w: number; left: boolean; bin?: Bin }

/**
 * A close-up of one town and the towns around it: a circle where the town is,
 * zoomed in so the circle stays inside the state or province, with state and
 * province lines, borders between countries, the coast and (in the US) county lines. The circle's outline is the town's name, repeated small
 * enough to read as a dotted line. Inside, a dot per artist from the town,
 * scattered, bigger the more their songs have been streamed. Nearby towns with bands
 * are marked; click one to look at its map. Opened by clicking a town's tab again.
 */
export function TownMap({ bin, bins, sceneWord, go, onClose, onOpenTown }: {
  bin: Bin;
  /** Every bin in the scene, to mark nearby towns with bands. */
  bins: Bin[];
  /** "your" for your own scene, "this" when looking around another town. */
  sceneWord: "your" | "this";
  go: Go;
  onClose: () => void;
  onOpenTown: (key: string) => void;
}) {
  const c = useCatalog();
  const loc = useLocation();
  const [data, setData] = useState<StatesData | null>(null);
  const [counties, setCounties] = useState<MultiLineString | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  // The map fills the rest of the window below it, so it's visible top to bottom without
  // scrolling (full screen included). Its height in map units follows the frame's shape.
  const frame = useRef<HTMLDivElement>(null);
  const [frameH, setFrameH] = useState<number | null>(null);
  // One map unit is one screen pixel: a bigger window shows more of the area around the town,
  // while the circle, dots and names stay the same size.
  const [W, setW] = useState(1000);
  const [H, setH] = useState(560);
  useLayoutEffect(() => {
    const el = frame.current;
    const scroller = el?.closest<HTMLElement>(".shell-main") ?? null;
    if (!el) return;
    const fit = () => {
      const width = el.clientWidth;
      if (!width) return;
      const viewH = scroller ? scroller.clientHeight : window.innerHeight;
      const top = scroller ? el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop : el.getBoundingClientRect().top + window.scrollY;
      const room = viewH - top - 50; // the screen's bottom padding
      const h = Math.round(Math.max(MIN_FRAME_PX, Math.min(room, width * 0.75)));
      setFrameH(h);
      setW(Math.round(width));
      setH(h);
    };
    fit();
    // While the window or sidebar is resizing, the map just stretches; it redraws once the size
    // settles (redrawing every frame of the sidebar's slide is what made it stutter).
    let timer = 0;
    const ro = new ResizeObserver(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(fit, 140);
    });
    ro.observe(el);
    if (scroller) ro.observe(scroller);
    return () => {
      ro.disconnect();
      window.clearTimeout(timer);
    };
  }, [data]); // the frame appears once the map has loaded
  const place = bin.place;
  useEffect(() => {
    // Every country's outlines, so a town near a border (Windsor, Detroit) shows the land across it.
    loadAllRegions().then(setData).catch(() => setData(null));
    if (place.country === "US") loadCountyLines().then(setCounties).catch(() => setCounties(null));
    else setCounties(null);
  }, [place.country]);
  const stateName = regionName(place);
  const isHomeState = (f: { properties: { code: string; country: string } }) => f.properties.code === place.state && f.properties.country === place.country;
  const homeState = data?.states.features.find(isHomeState);

  const projection = useMemo<GeoProjection | null>(() => {
    if (!data) return null;
    const p = geoMercator().center([place.lng, place.lat]).translate([W / 2, H / 2]).scale(10000);
    const perMile = Math.abs(p([place.lng, place.lat + 1])![1] - H / 2) / 69;
    // Keep the circle inside the state: no bigger than the distance to its nearest edge (border or coast).
    const edge = homeState ? edgeDistance(homeState.geometry, p, [W / 2, H / 2]) / perMile : MAX_RING_MI;
    const ringMi = Math.max(MIN_RING_MI, Math.min(MAX_RING_MI, edge - 1));
    return p.scale((10000 * R) / (ringMi * perMile)).clipExtent([[-20, -20], [W + 20, H + 20]]);
  }, [data, homeState, place.lng, place.lat, W, H]);

  const streamsOf = useMemo(() => {
    const byArtist: Record<string, number> = {};
    for (const t of c.tracks) byArtist[t.artistId] = (byArtist[t.artistId] ?? 0) + (c.streams[t.id] ?? 0);
    return byArtist;
  }, [c.tracks, c.streams]);

  const center: [number, number] = [W / 2, H / 2];
  const spots = useMemo(() => scatter(bin.artists.map(({ artist }) => ({ artist, streams: streamsOf[artist.id] ?? 0 })), center[0], center[1]), [bin.artists, streamsOf, W, H]); // eslint-disable-line react-hooks/exhaustive-deps

  // Names of the towns around it: towns with bands first, then the biggest, none overlapping or inside the circle.
  const labels = useMemo<Label[]>(() => {
    if (!projection) return [];
    const withBands = bins.filter((b) => b.key !== bin.key && b.artists.length);
    const bandKeys = new Set(withBands.map((b) => b.key));
    const towns: { p: Place; bin?: Bin }[] = [
      ...withBands.map((b) => ({ p: b.place, bin: b })),
      ...(loc.places ?? []).filter((p) => p.pop >= LABEL_MIN_POP && !bandKeys.has(placeKey(p)) && placeKey(p) !== bin.key).sort((a, b) => b.pop - a.pop).map((p) => ({ p })),
    ];
    const out: Label[] = [];
    for (const { p, bin: b } of towns) {
      const xy = projection([p.lng, p.lat]);
      if (!xy) continue;
      const [x, y] = xy;
      const text = b ? `${p.name} · ${b.artists.length}` : p.name;
      const w = text.length * (b ? 7.4 : 6.4) + 12;
      if (x < 8 || x > W - 8 || y < 14 || y > H - 8) continue;
      // The town itself can't sit in the circle.
      if (Math.hypot(x - center[0], y - center[1]) < R + 10) continue;
      // Its name goes to the right of it, or to the left if that's where the room is.
      const fits = (left: boolean) => {
        const box = left ? { x0: x - w, x1: x + 4 } : { x0: x - 4, x1: x + w };
        if (box.x0 < 4 || box.x1 > W - 4) return false;
        const [y0, y1] = [y - 9, y + 9];
        if (out.some((o) => { const ox0 = o.left ? o.x - o.w : o.x - 4, ox1 = o.left ? o.x + 4 : o.x + o.w; return box.x0 < ox1 && box.x1 > ox0 && y0 < o.y + 9 && y1 > o.y - 9; })) return false;
        const nx = Math.max(box.x0, Math.min(center[0], box.x1)), ny = Math.max(y0, Math.min(center[1], y1));
        return Math.hypot(nx - center[0], ny - center[1]) >= R + 6;
      };
      const left = !fits(false);
      if (left && !fits(true)) continue;
      out.push({ key: placeKey(p), text, x, y, w, left, bin: b });
      if (out.length >= 28) break;
    }
    return out;
  }, [projection, bins, bin.key, loc.places]); // eslint-disable-line react-hooks/exhaustive-deps

  // The land, coast and county outlines, cut to what's in view (the whole country's county
  // lines are huge), and only redrawn when the map moves, not on every hover.
  const shapes = useMemo(() => {
    if (!data || !projection) return null;
    const clipped = geoPath(projection);
    return {
      states: data.states.features.map((f) => ({ name: `${f.properties.country}-${f.properties.code}`, home: isHomeState(f), d: clipped(f) ?? undefined })).filter((s) => s.d),
      counties: counties ? clipped(counties) ?? undefined : undefined,
    };
  }, [data, counties, projection]);
  if (!data || !projection) return <div className="scene-map-loading muted">Loading map…</div>;
  const [cx, cy] = center;
  const ring = `M ${cx - R} ${cy} a ${R} ${R} 0 1 1 ${2 * R} 0 a ${R} ${R} 0 1 1 ${-2 * R} 0`;
  const circumference = 2 * Math.PI * R;
  const unit = `${place.name.toUpperCase()} · `;
  const repeats = Math.max(1, Math.floor(circumference / (unit.length * RING_FONT * 0.6)));
  const shown = spots.find((s) => s.artist.id === hover);
  const n = bin.artists.length;

  return (
    <div className="town-map">
      <div className="town-map-head">
        <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
          <span className="catalog muted" style={{ textTransform: "uppercase" }}>{place.country === "US" ? stateName : `${stateName}, ${COUNTRY_NAMES[place.country]}`}</span>
          <h2 className="display-md">{place.name}</h2>
          <span className="caption muted">{n} {n === 1 ? "artist" : "artists"} in {sceneWord} scene</span>
        </div>
        <button type="button" className="link-btn" style={{ fontWeight: 600 }} onClick={onClose}>Back to the bin</button>
      </div>
      <div ref={frame} className="town-map-frame" style={frameH ? { height: frameH } : undefined}>
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid slice" className="town-map-land" role="img" aria-label={`Map around ${place.name}, ${stateName}, with ${place.name} circled`}>
          {shapes?.states.map((f) => (
            <path key={f.name} d={f.d} fill="var(--map-land)" fillOpacity={f.home ? 1 : 0.55} />
          ))}
          {shapes?.counties && <path d={shapes.counties} fill="none" stroke="var(--ink-muted)" strokeOpacity="0.22" strokeWidth="0.8" strokeDasharray="3 3" />}
          {/* State lines and the coast, outlined the same way. */}
          {shapes?.states.map((f) => (
            <path key={f.name} d={f.d} fill="none" stroke="var(--ink-muted)" strokeOpacity="0.6" strokeWidth="1.3" strokeLinejoin="round" />
          ))}

          {labels.map((l) =>
            l.bin ? (
              <g key={l.key} className="town-near" tabIndex={0} role="link" aria-label={`${l.bin.place.name}: ${l.bin.artists.length} ${l.bin.artists.length === 1 ? "artist" : "artists"}. Show its map`}
                onClick={() => onOpenTown(l.bin!.key)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpenTown(l.bin!.key); } }}>
                <circle cx={l.x} cy={l.y} r="5" fill="var(--accent)" stroke="var(--ground-sunken)" strokeWidth="1.5" />
                <text x={l.left ? l.x - 10 : l.x + 10} y={l.y + 4} textAnchor={l.left ? "end" : "start"} className="town-near-name">{l.text}</text>
              </g>
            ) : (
              <g key={l.key} aria-hidden="true">
                <circle cx={l.x} cy={l.y} r="2.2" fill="var(--ink-muted)" fillOpacity="0.7" />
                <text x={l.left ? l.x - 7 : l.x + 7} y={l.y + 4} textAnchor={l.left ? "end" : "start"} className="town-other-name">{l.text}</text>
              </g>
            ),
          )}

          <circle cx={cx} cy={cy} r={R} fill="var(--accent)" fillOpacity="0.1" />
          <defs><path id="town-ring" d={ring} /></defs>
          <text className="town-ring" fontSize={RING_FONT} fill="var(--accent)" aria-hidden="true">
            <textPath href="#town-ring" textLength={circumference - 1} lengthAdjust="spacing">{unit.repeat(repeats)}</textPath>
          </text>
          {spots.map((s) => (
            <circle key={s.artist.id} cx={s.x} cy={s.y} r={s.r} fill={s.artist.accent} stroke="var(--ink)" strokeOpacity="0.45" strokeWidth="1.5"
              className="town-dot" tabIndex={0} role="link" aria-label={`${s.artist.name}: ${streamsWords(s.streams)}`}
              onMouseEnter={() => setHover(s.artist.id)} onMouseLeave={() => setHover(null)} onFocus={() => setHover(s.artist.id)} onBlur={() => setHover(null)}
              onClick={() => go({ name: "artist", artistId: s.artist.id })}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go({ name: "artist", artistId: s.artist.id }); } }} />
          ))}
        </svg>
        {shown && (
          <div className="town-tip" role="status" style={{ left: `${(shown.x / W) * 100}%`, top: `${((shown.y - shown.r - 8) / H) * 100}%` }}>
            <strong>{shown.artist.name}</strong>
            <span className="caption muted">{streamsWords(shown.streams)}</span>
          </div>
        )}
      </div>
    </div>
  );
}

/** Shortest distance (map units) from a point to the edge of a (multi)polygon, borders and coast alike. */
function edgeDistance(g: Geometry, p: GeoProjection, [x, y]: [number, number]): number {
  const polys: Position[][][] = g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : [];
  let best = Infinity;
  for (const poly of polys)
    for (const ring of poly) {
      let prev: [number, number] | null = null;
      for (const pt of ring) {
        const q = p(pt as [number, number]);
        if (q && prev) best = Math.min(best, segDist(x, y, prev, q));
        prev = q;
      }
    }
  return best;
}

function segDist(x: number, y: number, a: [number, number], b: [number, number]) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const t = dx || dy ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / (dx * dx + dy * dy))) : 0;
  return Math.hypot(x - (a[0] + t * dx), y - (a[1] + t * dy));
}

/** "1 stream", "1,204 streams". */
const streamsWords = (n: number) => `${n.toLocaleString("en-US")} ${n === 1 ? "stream" : "streams"}`;

/**
 * Dot radius in map units: more streams, bigger dot. Streams climb into the
 * thousands, so the size follows the number of digits: 10 streams is clearly
 * bigger than none, 10,000 is the biggest a dot gets.
 */
export const townDotRadius = (streams: number) => Math.min(26, 7 + 4.75 * Math.log10(1 + Math.max(0, streams)));

/**
 * Scatters dots inside the circle without overlaps, biggest first. Positions
 * come from each artist's id, so the same town always looks the same.
 */
export function scatter(items: { artist: Artist; streams: number }[], cx: number, cy: number): Spot[] {
  const placed: Spot[] = [];
  for (const it of [...items].sort((a, b) => b.streams - a.streams || a.artist.id.localeCompare(b.artist.id))) {
    let r = townDotRadius(it.streams);
    const rand = seeded(it.artist.id);
    let spot: Spot | null = null;
    for (let tries = 0; !spot && tries < 600; tries++) {
      if (tries && tries % 200 === 0) r *= 0.85; // crowded town: shrink a little and try again
      const room = R - r - 10;
      const a = rand() * Math.PI * 2;
      const d = Math.sqrt(rand()) * Math.max(0, room);
      const x = cx + Math.cos(a) * d, y = cy + Math.sin(a) * d;
      if (placed.every((p) => Math.hypot(p.x - x, p.y - y) >= p.r + r + 6)) spot = { ...it, x, y, r };
    }
    placed.push(spot ?? { ...it, x: cx, y: cy, r });
  }
  return placed;
}

/** A small seeded random number generator (mulberry32 on a string hash). */
function seeded(key: string) {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  return () => {
    h = (h + 0x6d2b79f5) | 0;
    let t = Math.imul(h ^ (h >>> 15), 1 | h);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
