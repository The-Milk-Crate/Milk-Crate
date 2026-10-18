import { useMemo, useState } from "react";
import { MapPin } from "lucide-react";
import type { Go } from "../App";
import { useCatalog } from "../lib/catalog";
import { useArtistPlaces, useLocation, useUnits } from "../lib/location";
import { COUNTRIES, COUNTRY_NAMES, findPlace, placeKey, regionName, sceneFor, SCENE_RADIUS_MI, distanceWords, type Country, type Place } from "../lib/geo";
import { buildBins, type Bin } from "../lib/bins";
import { Button } from "../components/ui";
import { CrateBins } from "../components/CrateBins";
import { CountryMap } from "../components/CountryMap";
import { CityPicker } from "../components/CityPicker";
import { RadioButton } from "../components/RadioButton";
import { EmptyCatalog } from "./Artists";

/**
 * Scenes, as record-store bins. "Your scene": one divider per town around you
 * where a band has released music, nearest first; open a town's bin and flip
 * through its records. "Across the country": a map of every town with bands in
 * the United States, Canada or Australia; pick one to look around its bins
 * without changing your own city.
 */
export function Scenes({ go, explore }: { go: Go; explore?: { name: string; state: string; country?: Country } }) {
  const loc = useLocation();
  const { releases, status } = useCatalog();
  const placed = useArtistPlaces();
  const units = useUnits();
  const [view, setView] = useState<"scene" | "national">("scene");
  const [mapCountry, setMapCountry] = useState<Country | null>(null);

  const explorePlace = explore && loc.places ? findPlace(loc.places, explore.name, explore.state, explore.country ?? "US") : undefined;
  const scene = explorePlace && loc.places ? sceneFor(explorePlace, loc.places) : loc.scene;
  const bins = useMemo(() => (scene ? buildBins(scene, placed, releases) : []), [scene, placed, releases]);
  if (!scene) return <div className="screen"><p className="muted">Loading your scene…</p></div>;

  const home = loc.home;
  const exploring = !!explorePlace && (!home || placeKey(explorePlace) !== placeKey(home));
  const national = view === "national";
  const browse = (p: Place) => {
    setView("scene");
    go(home && placeKey(p) === placeKey(home) ? { name: "scenes" } : { name: "scenes", explore: { name: p.name, state: p.state, country: p.country } });
  };
  // The map shows the country you're looking at, unless you pick another.
  const country = mapCountry ?? scene.home.country;
  const counts = Object.fromEntries(COUNTRIES.map((c) => [c, placed.filter((a) => a.place.country === c).length])) as Record<Country, number>;

  return (
    <div className="screen scenes">
      {exploring && (
        <div role="status" className="explore-banner">
          <MapPin size={18} strokeWidth={1.75} aria-hidden="true" style={{ color: "var(--accent)", flex: "none" }} />
          <span style={{ flex: "1 1 280px" }}>
            You&apos;re looking around <strong>{scene.home.name}</strong>.{home ? ` Your scene and your account stay set to ${home.name}.` : ""}
          </span>
          {home && <Button size="sm" onClick={() => go({ name: "scenes" })}>Back to {home.name}</Button>}
        </div>
      )}

      <header className="screen-head" style={{ alignItems: "flex-end" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
          <span className="catalog" style={{ textTransform: "uppercase", color: "var(--accent)" }}>
            {national ? `Across ${country === "US" ? "the United States" : COUNTRY_NAMES[country]}` : `${exploring ? "Exploring" : "Your scene"} · ${regionName(scene.home)}${scene.home.country !== home?.country ? `, ${COUNTRY_NAMES[scene.home.country]}` : ""}`}
          </span>
          <h1 className="display-lg">{national ? "Every Scene" : scene.home.name}</h1>
          {!national && !exploring && (
            <div><Button size="sm" onClick={() => go({ name: "account" })}>Change your city</Button></div>
          )}
          {!national && <div style={{ marginTop: 6 }}><RadioButton scene={scene} /></div>}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          {!national && <MiniMap bins={bins} label={`The ${distanceWords(SCENE_RADIUS_MI, units)} around ${scene.home.name}. Open the map of every scene`} onOpen={() => setView("national")} />}
          <div role="group" aria-label="Scenes view" className="view-toggle">
            <button type="button" aria-pressed={!national} onClick={() => setView("scene")}>{exploring ? scene.home.name : "Your scene"}</button>
            <button type="button" aria-pressed={national} onClick={() => setView("national")}>Across the country</button>
          </div>
        </div>
      </header>

      {national ? (
        <>
          <div role="group" aria-label="Country" className="country-switch">
            {COUNTRIES.map((c) => (
              <button key={c} type="button" className="chip" aria-pressed={c === country} onClick={() => setMapCountry(c)}>
                {COUNTRY_NAMES[c]} <span className="numeral muted">{counts[c]}</span>
              </button>
            ))}
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-end", gap: 12 }}>
            <div style={{ flex: "0 1 360px", minWidth: 220 }}>
              <CityPicker label="Look around another town" value={null} onChange={browse} />
            </div>
          </div>
          {placed.length ? (
            <CountryMap key={country} country={country} placed={placed} places={loc.places} home={home} onBrowse={browse} />
          ) : (
            <EmptyCatalog go={go} offline={status === "offline"} what="No artists have released music on Milk Crate yet." />
          )}
        </>
      ) : (
        <CrateBins key={placeKey(scene.home)} bins={bins} centerTag={exploring ? "Here" : "Home"} go={go} />
      )}
    </div>
  );
}

/** A thumbnail of the scene: the 35-mile (56 km) circle with a dot per town. Opens the big map. */
function MiniMap({ bins, label, onOpen }: { bins: Bin[]; label: string; onOpen: () => void }) {
  const center = bins[0]?.place;
  if (!center) return null;
  const W = 132, H = 88, R = 30;
  const dots = bins.map((b) => {
    const dx = (b.place.lng - center.lng) * Math.cos((center.lat * Math.PI) / 180) * 69.17;
    const dy = -(b.place.lat - center.lat) * 69;
    let x = (dx / 35) * R, y = (dy / 35) * R;
    const d = Math.hypot(x, y);
    const max = 38;
    if (d > max) { x = (x / d) * max; y = (y / d) * max; }
    return { b, x: W / 2 + x, y: H / 2 + y };
  });
  return (
    <button type="button" className="mini-map" onClick={onOpen} aria-label={label}>
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} aria-hidden="true">
        <circle cx={W / 2} cy={H / 2} r={R} fill="var(--accent)" fillOpacity="0.1" stroke="var(--accent)" strokeOpacity="0.6" strokeDasharray="3 3" />
        {dots.map(({ b, x, y }) =>
          b.artists.length ? (
            <circle key={b.key} cx={x} cy={y} r={b.isCenter ? 4.5 : 3.2} fill={b.artists[0].artist.accent} stroke="var(--ground-sunken)" strokeWidth="1" />
          ) : (
            <circle key={b.key} cx={x} cy={y} r="4" fill="none" stroke="var(--accent)" strokeWidth="1.5" />
          ),
        )}
      </svg>
    </button>
  );
}
