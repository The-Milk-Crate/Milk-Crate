import { useMemo, useState } from "react";
import { MapPin } from "lucide-react";
import type { Go } from "../App";
import { useCatalog } from "../lib/catalog";
import { useArtistPlaces, useLocation } from "../lib/location";
import { STATE_NAMES, findPlace, placeKey, sceneFor, type Place } from "../lib/geo";
import { buildBins, type Bin } from "../lib/bins";
import { Button } from "../components/ui";
import { CrateBins } from "../components/CrateBins";
import { CountryMap } from "../components/CountryMap";
import { CityPicker } from "../components/CityPicker";
import { EmptyCatalog } from "./Artists";

/**
 * Scenes, as record-store bins. "Your scene": one divider per town around you
 * where a band has released music, nearest first; open a town's bin and flip
 * through its records. "Across the country": a map of every town with bands;
 * pick one to look around its bins without changing your own city.
 */
export function Scenes({ go, explore }: { go: Go; explore?: { name: string; state: string } }) {
  const loc = useLocation();
  const { releases, status } = useCatalog();
  const placed = useArtistPlaces();
  const [view, setView] = useState<"scene" | "national">("scene");

  const explorePlace = explore && loc.places ? findPlace(loc.places, explore.name, explore.state) : undefined;
  const scene = explorePlace && loc.places ? sceneFor(explorePlace, loc.places) : loc.scene;
  const bins = useMemo(() => (scene ? buildBins(scene, placed, releases) : []), [scene, placed, releases]);
  if (!scene) return <div className="screen"><p className="muted">Loading your scene…</p></div>;

  const home = loc.home;
  const exploring = !!explorePlace && (!home || placeKey(explorePlace) !== placeKey(home));
  const national = view === "national";
  const browse = (p: Place) => {
    setView("scene");
    go(home && placeKey(p) === placeKey(home) ? { name: "scenes" } : { name: "scenes", explore: { name: p.name, state: p.state } });
  };

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
            {national ? "Across the country" : `${exploring ? "Exploring" : "Your scene"} · ${STATE_NAMES[scene.home.state] ?? scene.home.state}`}
          </span>
          <h1 className="display-lg">{national ? "Every scene" : scene.home.name}</h1>
          <span className="caption muted">
            {national
              ? `Look around any town's bins.${home ? ` Your own city stays ${home.name}.` : ""}`
              : "Flip through the scene one town at a time, nearest first."}
            {!national && !exploring && (
              <> · <button type="button" className="link-btn" onClick={() => go({ name: "account" })}>Change your city</button></>
            )}
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          {!national && <MiniMap bins={bins} onOpen={() => setView("national")} />}
          <div role="group" aria-label="Scenes view" className="view-toggle">
            <button type="button" aria-pressed={!national} onClick={() => setView("scene")}>{exploring ? scene.home.name : "Your scene"}</button>
            <button type="button" aria-pressed={national} onClick={() => setView("national")}>Across the country</button>
          </div>
        </div>
      </header>

      {national ? (
        <>
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-end", gap: 12 }}>
            <div style={{ flex: "0 1 360px", minWidth: 220 }}>
              <CityPicker label="Look around another town" value={null} onChange={browse} />
            </div>
            <span className="caption muted" style={{ paddingBottom: 12 }}>Only towns where a band has released music show up on the map.</span>
          </div>
          {placed.length ? (
            <CountryMap placed={placed} places={loc.places} home={home} onBrowse={browse} />
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

/** A thumbnail of the scene: the 35-mile circle with a dot per town. Opens the big map. */
function MiniMap({ bins, onOpen }: { bins: Bin[]; onOpen: () => void }) {
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
    <button type="button" className="mini-map" onClick={onOpen} aria-label="Open the map of every scene">
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
