import { useEffect, useMemo, useState } from "react";
import { geoAlbersUsa, geoPath, type GeoProjection } from "d3-geo";
import type { Feature, Geometry } from "geojson";
import type { ArtistPlace } from "../lib/location";
import { STATE_NAMES, miles, placeKey, sceneFor, sceneWithArtists, type Place } from "../lib/geo";
import { loadStates, placeLabels, type StatesData } from "../lib/mapLayout";
import { milesLabel } from "../lib/bins";
import { ArtistThumb } from "./ArtistBanner";
import { Button } from "./ui";

const W = 1000;
const H = 620;
/** Towns closer than this on the map (viewBox units, about px) share one dot. */
const MERGE = 26;

interface Town { key: string; place: Place; artists: ArtistPlace[]; x: number; y: number; towns: Place[] }

/**
 * Across the country: every town where a band has released music, as numbered
 * dots on a map of the US (nearby towns share a dot). Pick one to see who's
 * there, then browse its bins. Looking around never changes your own city.
 */
export function CountryMap({ placed, places, home, onBrowse }: {
  placed: ArtistPlace[];
  /** Every US place (for the "towns nearby" line), once loaded. */
  places: Place[] | null;
  home: Place | null;
  onBrowse: (p: Place) => void;
}) {
  const [data, setData] = useState<StatesData | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  useEffect(() => {
    loadStates().then(setData).catch(() => setData(null));
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setPicked(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const projection = useMemo<GeoProjection | null>(
    () => (data ? (geoAlbersUsa().fitExtent([[16, 16], [W - 16, H - 16]], data.states) as unknown as GeoProjection) : null),
    [data],
  );

  const layout = useMemo(() => {
    if (!projection) return null;
    const at = (p: Place) => projection([p.lng, p.lat]) as [number, number] | null;
    // One group per town, biggest first, then merge towns that would sit on top of each other.
    const byTown = new Map<string, ArtistPlace[]>();
    for (const a of placed) byTown.set(placeKey(a.place), [...(byTown.get(placeKey(a.place)) ?? []), a]);
    const towns: Town[] = [];
    for (const [key, artists] of [...byTown].sort((a, b) => b[1].length - a[1].length || b[1][0].place.pop - a[1][0].place.pop)) {
      const xy = at(artists[0].place);
      if (!xy) continue;
      const near = towns.find((t) => Math.hypot(t.x - xy[0], t.y - xy[1]) < MERGE);
      if (near) {
        near.artists.push(...artists);
        near.towns.push(artists[0].place);
      } else towns.push({ key, place: artists[0].place, artists: [...artists], x: xy[0], y: xy[1], towns: [artists[0].place] });
    }
    const homeXY = home ? at(home) : null;
    const homeKey = homeXY ? towns.find((t) => Math.hypot(t.x - homeXY[0], t.y - homeXY[1]) < MERGE)?.key ?? null : null;
    const r = (t: Town) => pinSize(t.artists.length) / 2;
    const labels = placeLabels(
      towns.map((t) => ({ key: t.key, text: t.key === homeKey ? `You · ${t.place.name}` : t.place.name, size: 12, wide: false, cx: t.x, cy: t.y, R: r(t) })),
      towns.map((t) => ({ x: t.x, y: t.y, r: r(t) })),
      W, H,
    );
    return { towns, homeXY, homeKey, labels };
  }, [projection, placed, home]);

  if (!data || !projection || !layout) return <div className="scene-map-loading muted">Loading map…</div>;
  const path = geoPath(projection);
  const town = layout.towns.find((t) => t.key === picked) ?? null;

  return (
    <div className="country-map">
      <div className="country-map-frame">
        <svg viewBox={`0 0 ${W} ${H}`} aria-hidden="true" className="country-map-land">
          {data.states.features.map((f: Feature<Geometry, { name: string }>) => (
            <path key={f.properties.name} d={path(f) ?? undefined} fill="var(--map-land)" />
          ))}
          <path d={path(data.borders) ?? undefined} fill="none" stroke="var(--line-strong)" strokeOpacity="0.55" strokeWidth="0.8" />
          {layout.homeXY && !layout.homeKey && (
            <circle cx={layout.homeXY[0]} cy={layout.homeXY[1]} r="9" fill="none" stroke="var(--accent)" strokeWidth="2" strokeDasharray="3 3" />
          )}
        </svg>

        {layout.labels.map((l) => {
          const t = layout.towns.find((x) => x.key === l.key)!;
          return (
            <span key={l.key} aria-hidden="true" className={`map-label caption${l.key === layout.homeKey ? " home" : ""}`}
              style={{ left: `${(l.box.x / W) * 100}%`, top: `${(l.box.y / H) * 100}%`, width: `${(l.box.w / W) * 100}%`, textAlign: l.anchor === "start" ? "left" : l.anchor === "end" ? "right" : "center" }}>
              {l.key === layout.homeKey ? `You · ${t.place.name}` : t.place.name}
            </span>
          );
        })}
        {layout.towns.map((t) => {
          const n = t.artists.length;
          const size = pinSize(n);
          return (
            <button key={t.key} type="button" aria-pressed={picked === t.key}
              aria-label={`${t.towns.length > 1 ? `${t.place.name} area` : t.place.name}, ${STATE_NAMES[t.place.state] ?? t.place.state}: ${n} ${n === 1 ? "artist" : "artists"}`}
              className={`map-pin numeral${t.key === layout.homeKey ? " home" : ""}`}
              style={{ left: `${(t.x / W) * 100}%`, top: `${(t.y / H) * 100}%`, width: size, height: size }}
              onClick={() => setPicked(picked === t.key ? null : t.key)}>
              {n}
            </button>
          );
        })}

        {town && <TownCard town={town} places={places} placed={placed} home={home} isHome={town.key === layout.homeKey} onBrowse={onBrowse} onClose={() => setPicked(null)} />}
      </div>
    </div>
  );
}

const pinSize = (n: number) => Math.round(Math.min(40, 22 + 5 * Math.sqrt(n - 1)));

function TownCard({ town, places, placed, home, isHome, onBrowse, onClose }: {
  town: Town; places: Place[] | null; placed: ArtistPlace[]; home: Place | null; isHome: boolean;
  onBrowse: (p: Place) => void; onClose: () => void;
}) {
  const left = town.x / W > 0.55;
  const nearby = useMemo(() => {
    if (!places) return [];
    const live = sceneWithArtists(sceneFor(town.place, places), placed.map((a) => a.place));
    return live.nearby.filter((p) => !town.towns.some((t) => placeKey(t) === placeKey(p)));
  }, [places, placed, town]);
  const shown = town.artists.slice(0, 3);
  const more = town.artists.length - shown.length;
  const name = town.towns.length > 1 ? `${town.place.name} area` : town.place.name;
  return (
    <div role="dialog" aria-label={name} className="map-card"
      style={{ top: `${Math.min(Math.max((town.y / H) * 100, 18), 70)}%`, ...(left ? { right: `${100 - (town.x / W) * 100 + 3}%` } : { left: `${(town.x / W) * 100 + 3}%` }) }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
          <span className="catalog muted" style={{ textTransform: "uppercase" }}>
            {[STATE_NAMES[town.place.state] ?? town.place.state, isHome ? "Your scene" : home ? `${milesLabel(miles(home, town.place))} from you` : null].filter(Boolean).join(" · ")}
          </span>
          <h2 className="display-md">{name}</h2>
        </div>
        <button type="button" className="mc-icon-btn" aria-label="Close" onClick={onClose}>×</button>
      </div>
      {shown.map(({ artist: a, place }) => (
        <div key={a.id} style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
          <ArtistThumb artist={a} size={36} />
          <span style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
            <span style={{ fontWeight: 650 }}>{a.name}</span>
            <span className="caption muted">{[a.genres.slice(0, 2).join(", "), town.towns.length > 1 ? place.name : null].filter(Boolean).join(" · ")}</span>
          </span>
        </div>
      ))}
      {more > 0 && <span className="caption muted">and {more} more</span>}
      {nearby.length > 0 && (
        <span className="caption muted">
          {nearby.length} more {nearby.length === 1 ? "town" : "towns"} with bands within 35 miles: {nearby.slice(0, 3).map((p) => p.name).join(", ")}{nearby.length > 3 ? "…" : ""}
        </span>
      )}
      <Button variant="primary" onClick={() => onBrowse(town.place)}>{isHome ? "Go to your scene" : `Browse ${town.place.name}'s bins`}</Button>
    </div>
  );
}
