import { useState } from "react";
import type { Go } from "../App";
import { useCatalog } from "../lib/catalog";
import { useArtistPlaces, useLocation } from "../lib/location";
import { STATE_NAMES, findPlace, inScene, placeKey, placeLabel, sceneFor, sceneSummary, type Place } from "../lib/geo";
import { ReleaseCard, Sticker } from "../components/ui";
import { ArtistThumb } from "../components/ArtistBanner";
import { SceneMap } from "../components/SceneMap";
import { EmptyCatalog } from "./Artists";

/**
 * Scenes: the music around where you live (your city, the towns nearby and
 * your state's larger cities) on a real map, or every city with artists on
 * Milk Crate. You can also explore another city's scene.
 */
export function Scenes({ go, explore }: { go: Go; explore?: { name: string; state: string } }) {
  const loc = useLocation();
  const { releases, artistById, status } = useCatalog();
  const everyone = useArtistPlaces();
  const [view, setView] = useState<"scene" | "national">("scene");
  const [hovered, setHovered] = useState<string | null>(null);

  const explorePlace = explore && loc.places ? findPlace(loc.places, explore.name, explore.state) : undefined;
  const scene = explorePlace && loc.places ? sceneFor(explorePlace, loc.places) : loc.scene;
  if (!scene) return <div className="screen"><p className="muted">Loading your scene…</p></div>;

  const local = view === "scene";
  const here = everyone.filter((a) => inScene(scene, a.place));
  const rising = [...here].sort((a, b) => b.artist.since - a.artist.since);
  const hereIds = new Set(here.map((a) => a.artist.id));
  const sceneReleases = releases.filter((r) => hereIds.has(r.artistId));

  const cities = new Map<string, { place: Place; count: number }>();
  for (const a of everyone) {
    const k = placeKey(a.place);
    cities.set(k, { place: a.place, count: (cities.get(k)?.count ?? 0) + 1 });
  }
  const cityList = [...cities.values()].sort((a, b) => b.count - a.count || b.place.pop - a.place.pop);

  return (
    <div>
      <header style={{ background: "var(--dairy-soft)", padding: "40px 32px 32px", display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "flex-end", gap: 24 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}>
          <span className="catalog" style={{ textTransform: "uppercase", color: "var(--dairy)" }}>
            {local ? `${explorePlace ? "Exploring" : "Your scene"} · ${STATE_NAMES[scene.home.state] ?? scene.home.state}` : "Milk Crate"}
          </span>
          <h1 className="display-xl">{local ? scene.home.name : "Every scene"}</h1>
          <p className="muted" style={{ maxWidth: 560 }}>
            {local ? sceneSummary(scene) || "Your city and the towns around it." : "Every city with artists on Milk Crate. Pick one to hear what it sounds like."}
          </p>
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
            {explorePlace ? (
              <button type="button" className="link-btn" onClick={() => go({ name: "scenes" })}>Back to your scene</button>
            ) : (
              <button type="button" className="link-btn" onClick={() => go({ name: "account" })}>Change your city</button>
            )}
          </div>
        </div>
        <div role="group" aria-label="Map view" style={{ display: "flex", gap: 4, padding: 4, borderRadius: 8, background: "var(--ground)" }}>
          {(["scene", "national"] as const).map((v) => (
            <button key={v} type="button" className="chip" aria-pressed={view === v} onClick={() => setView(v)}
              style={view === v ? { background: "var(--dairy)", color: "var(--ground)", borderColor: "var(--dairy)" } : { borderColor: "transparent" }}>
              {v === "scene" ? (explorePlace ? "This scene" : "Your scene") : "Across the country"}
            </button>
          ))}
        </div>
      </header>

      <div className="screen">
        <div style={{ display: "flex", flexWrap: "wrap", gap: 32, alignItems: "flex-start" }}>
          <figure className="panel" style={{ margin: 0, flex: "999 1 420px", minWidth: 0, padding: 0, overflow: "hidden", gap: 0 }}>
            <SceneMap mode={local ? "scene" : "national"} scene={scene} artists={local ? here : everyone}
              hovered={hovered} onHover={setHovered} onOpen={(id) => go({ name: "artist", artistId: id })} />
            <figcaption style={{ display: "flex", flexWrap: "wrap", gap: 16, padding: "12px 16px", borderTop: "1px solid var(--line)", fontSize: 12, color: "var(--ink-muted)" }}>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <span aria-hidden="true" style={{ display: "inline-flex" }}>
                  {["#ff5b3a", "#ffd43b", "#7aa2ff"].map((c) => <span key={c} style={{ width: 10, height: 10, borderRadius: "50%", background: c, marginRight: -3, boxShadow: "0 0 0 2px var(--ground-raised)" }} />)}
                </span>
                &nbsp;A band, in its profile color
              </span>
              {local && <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><span aria-hidden="true" style={{ width: 10, height: 10, borderRadius: "50%", border: "1.5px dashed var(--dairy)" }} />Within 35 miles</span>}
              <span>Map: U.S. Census Bureau · Cities: GeoNames</span>
            </figcaption>
          </figure>

          {local ? (
            <section className="section" style={{ flex: "1 1 300px", minWidth: 0, gap: 12 }}>
              <h2 className="display-md">Up and coming</h2>
              <p className="caption muted">Newest artists first. No follower counts.</p>
              {rising.length === 0 && <p className="muted">No artists from around {scene.home.name} on Milk Crate yet.</p>}
              {rising.map(({ artist: a, place }) => (
                <button key={a.id} type="button" className="nav-item" style={{ height: "auto", padding: 8, gap: 12, color: "var(--ink)" }}
                  onClick={() => go({ name: "artist", artistId: a.id })} onMouseEnter={() => setHovered(a.id)} onMouseLeave={() => setHovered(null)}>
                  <ArtistThumb artist={a} size={48} />
                  <span style={{ flex: "1 1 auto", minWidth: 0, display: "flex", flexDirection: "column" }}>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                      <span aria-hidden="true" style={{ width: 10, height: 10, borderRadius: "50%", background: a.accent, flex: "none" }} />
                      {a.name}
                    </span>
                    <span className="caption muted" style={{ fontWeight: 450 }}>{[a.genres.join(", "), `since ${a.since}`].filter(Boolean).join(" · ")}</span>
                  </span>
                  <Sticker tone="dairy">{place.name}</Sticker>
                </button>
              ))}
            </section>
          ) : (
            <section className="section" style={{ flex: "1 1 300px", minWidth: 0, gap: 8 }}>
              <h2 className="display-md">Cities with artists</h2>
              {cityList.length === 0 && <EmptyCatalog go={go} offline={status === "offline"} what="No artists on Milk Crate yet." />}
              {cityList.map(({ place, count }) => (
                <button key={placeKey(place)} type="button" className="nav-item" style={{ height: "auto", padding: "8px 12px", justifyContent: "space-between", color: "var(--ink)" }}
                  onClick={() => { setView("scene"); go({ name: "scenes", explore: { name: place.name, state: place.state } }); }}>
                  <span>{placeLabel(place)}</span>
                  <span className="caption muted">{count} {count === 1 ? "artist" : "artists"}</span>
                </button>
              ))}
            </section>
          )}
        </div>

        {local && (
          <section className="section">
            <h2 className="display-md">Released around {scene.home.name}</h2>
            {sceneReleases.length ? (
              <div className="release-grid">
                {sceneReleases.map((r) => (
                  <ReleaseCard key={r.id} title={r.title} artist={artistById[r.artistId]?.name ?? ""} year={r.year} art={r.art} onOpen={() => go({ name: "artist", artistId: r.artistId })} />
                ))}
              </div>
            ) : (
              <p className="muted">No releases from this scene on Milk Crate yet.</p>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
