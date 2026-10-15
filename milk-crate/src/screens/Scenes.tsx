import { useState } from "react";
import type { Go } from "../App";
import { sceneById, scenes } from "../data/scenes";
import { useCatalog } from "../lib/catalog";
import type { Artist } from "../lib/types";
import { ReleaseCard, Sleeve, Sticker } from "../components/ui";

/** Where each neighborhood cluster sits on the (illustrative) scene map. */
const CLUSTER_SPOTS: [number, number][] = [[490, 150], [270, 110], [110, 215], [290, 240], [400, 260], [560, 240]];

function hash(s: string) {
  let x = 2166136261;
  for (let i = 0; i < s.length; i++) {
    x ^= s.charCodeAt(i);
    x = Math.imul(x, 16777619);
  }
  return x >>> 0;
}

/** Spreads the dots in one cluster evenly around its center, starting at an angle seeded by the place name. */
function dotPositions<T extends { id: string }>(items: T[], [cx, cy]: [number, number], seed: string) {
  const start = (hash(seed) % 360) * (Math.PI / 180);
  return items.map((item, i) => {
    if (items.length === 1) return { item, x: cx, y: cy };
    const ring = i < 6 ? 0 : 1;
    const inRing = ring === 0 ? Math.min(items.length, 6) : items.length - 6;
    const idx = ring === 0 ? i : i - 6;
    const r = ring === 0 ? 24 : 44;
    const a = start + (idx / inRing) * Math.PI * 2;
    return { item, x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r };
  });
}

const cityOf = (place: string) => place.split(",")[0].trim();

/**
 * Scenes: artists and releases from one city, plus every scene across the country.
 * On the map, every band is its own dot in its profile color (the color it
 * chose for its artist page). The map is an illustration for now; swap in a
 * real map (e.g. MapLibre) once artists have coordinates.
 */
export function Scenes({ go, sceneId = "rdu" }: { go: Go; sceneId?: string }) {
  const { artists, releases } = useCatalog();
  const [view, setView] = useState<"local" | "national">("local");
  const [hovered, setHovered] = useState<string | null>(null);
  const scene = sceneById[sceneId] ?? scenes[0];
  const sceneArtists = artists.filter((a) => a.sceneId === scene.id);
  const rising = [...sceneArtists].sort((a, b) => b.since - a.since);
  const sceneReleases = releases.filter((r) => sceneArtists.some((a) => a.id === r.artistId));
  const local = view === "local";

  const clusters = scene.places.map((place, i) => {
    const spot = CLUSTER_SPOTS[i % CLUSTER_SPOTS.length];
    const here = sceneArtists.filter((a) => cityOf(a.place) === place);
    return { place, spot, dots: dotPositions<Artist>(here, spot, place) };
  });
  const hoveredArtist = sceneArtists.find((a) => a.id === hovered);

  return (
    <div>
      <header style={{ background: "var(--dairy-soft)", padding: "40px 32px 32px", display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "flex-end", gap: 24 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <span className="catalog" style={{ textTransform: "uppercase", color: "var(--dairy)" }}>Scene · {scene.region}</span>
          <h1 className="display-xl">{local ? scene.name : "Every scene"}</h1>
          <p className="muted" style={{ maxWidth: 520 }}>
            {local ? `${scene.places.join(", ")}. ${scene.sound ?? ""}` : "Pick a city to hear what it sounds like right now."}
          </p>
        </div>
        <div role="group" aria-label="Map view" style={{ display: "flex", gap: 4, padding: 4, borderRadius: 8, background: "var(--ground)" }}>
          {(["local", "national"] as const).map((v) => (
            <button key={v} type="button" className="chip" aria-pressed={view === v} onClick={() => setView(v)}
              style={view === v ? { background: "var(--dairy)", color: "var(--ground)", borderColor: "var(--dairy)" } : { borderColor: "transparent" }}>
              {v === "local" ? "Your city" : "Across the country"}
            </button>
          ))}
        </div>
      </header>

      <div className="screen">
        {local ? (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 32, alignItems: "flex-start" }}>
            <figure className="panel" style={{ margin: 0, flex: "999 1 420px", minWidth: 0, padding: 0, overflow: "hidden", gap: 0 }}>
              <svg viewBox="0 0 640 320" role="group" aria-label={`Map of the ${scene.name} scene`} style={{ display: "block", width: "100%", height: "auto" }}>
                <path d="M0 230 C120 210 200 170 300 160 S500 100 640 70" fill="none" stroke="var(--line-strong)" strokeWidth="3" aria-hidden="true" />
                {clusters.map(({ place, spot: [x, y] }) => (
                  <g key={place} aria-hidden="true">
                    <circle cx={x} cy={y} r="54" fill="var(--dairy)" opacity="0.14" />
                    <text x={x} y={y - 66} textAnchor="middle" fill="var(--ink)" fontFamily="var(--font-display)" fontSize="15">{place}</text>
                  </g>
                ))}
                {clusters.flatMap(({ dots }) =>
                  dots.map(({ item: a, x, y }) => (
                    <g
                      key={a.id}
                      role="link"
                      tabIndex={0}
                      aria-label={`${a.name}, ${a.place}`}
                      style={{ cursor: "pointer", outline: "none" }}
                      onClick={() => go({ name: "artist", artistId: a.id })}
                      onKeyDown={(e) => e.key === "Enter" && go({ name: "artist", artistId: a.id })}
                      onMouseEnter={() => setHovered(a.id)}
                      onMouseLeave={() => setHovered(null)}
                      onFocus={() => setHovered(a.id)}
                      onBlur={() => setHovered(null)}
                    >
                      <circle cx={x} cy={y} r={hovered === a.id ? 11 : 8} fill={a.accent} stroke="var(--ground-raised)" strokeWidth="2.5" style={{ transition: "r .15s ease-out" }} />
                      {hovered === a.id && <circle cx={x} cy={y} r="15" fill="none" stroke="var(--focus)" strokeWidth="2" />}
                    </g>
                  )),
                )}
                {hoveredArtist && (() => {
                  const d = clusters.flatMap((c) => c.dots).find((p) => p.item.id === hoveredArtist.id)!;
                  const w = hoveredArtist.name.length * 8 + 24;
                  const left = Math.min(Math.max(d.x - w / 2, 4), 636 - w);
                  return (
                    <g pointerEvents="none" aria-hidden="true">
                      <rect x={left} y={d.y - 46} width={w} height="26" rx="6" fill="var(--ground)" stroke="var(--line)" />
                      <circle cx={left + 12} cy={d.y - 33} r="5" fill={hoveredArtist.accent} />
                      <text x={left + 22} y={d.y - 28.5} fill="var(--ink)" fontFamily="var(--font-sans)" fontWeight="600" fontSize="13">{hoveredArtist.name}</text>
                    </g>
                  );
                })()}
              </svg>
              <figcaption style={{ display: "flex", flexWrap: "wrap", gap: 16, padding: "12px 16px", borderTop: "1px solid var(--line)", fontSize: 12, color: "var(--ink-muted)" }}>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                  <span aria-hidden="true" style={{ display: "inline-flex" }}>
                    {(sceneArtists.length ? sceneArtists.slice(0, 4).map((a) => a.accent) : ["#ff5b3a", "#ffd43b", "#7aa2ff"]).map((c, i) => <span key={i} style={{ width: 10, height: 10, borderRadius: "50%", background: c, marginRight: -3, boxShadow: "0 0 0 2px var(--ground-raised)" }} />)}
                  </span>
                  &nbsp;A band, in its profile color
                </span>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><span aria-hidden="true" style={{ width: 10, height: 10, borderRadius: "50%", background: "var(--dairy)", opacity: 0.4 }} />Neighborhood</span>
              </figcaption>
            </figure>
            <section className="section" style={{ flex: "1 1 300px", minWidth: 0, gap: 12 }}>
              <h2 className="display-md">Up and coming</h2>
              <p className="caption muted">Newest artists first. No follower counts.</p>
              {rising.length === 0 && <p className="muted">No artists from {scene.name} on Milk Crate yet.</p>}
              {rising.map((a) => (
                <button key={a.id} type="button" className="nav-item" style={{ height: "auto", padding: 8, gap: 12, color: "var(--ink)" }}
                  onClick={() => go({ name: "artist", artistId: a.id })}
                  onMouseEnter={() => setHovered(a.id)} onMouseLeave={() => setHovered(null)}>
                  <Sleeve seed={a.name} style={{ width: 48, flex: "none" }} />
                  <span style={{ flex: "1 1 auto", minWidth: 0, display: "flex", flexDirection: "column" }}>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                      <span aria-hidden="true" style={{ width: 10, height: 10, borderRadius: "50%", background: a.accent, flex: "none" }} />
                      {a.name}
                    </span>
                    <span className="caption muted" style={{ fontWeight: 450 }}>{a.genres.join(", ")} · since {a.since}</span>
                  </span>
                  <Sticker tone="dairy">{cityOf(a.place)}</Sticker>
                </button>
              ))}
            </section>
          </div>
        ) : (
          <section className="section">
            <h2 className="display-md">Scenes across the country</h2>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 16 }}>
              {scenes.map((s) => (
                <button key={s.id} type="button" className="panel" style={{ border: 0, textAlign: "left", color: "var(--ink)", cursor: "pointer", gap: 8, padding: 16, borderRadius: 8 }}
                  onClick={() => { setView("local"); go({ name: "scenes", sceneId: s.id }); }}>
                  <span className="catalog" style={{ textTransform: "uppercase", color: "var(--dairy)" }}>{s.region}</span>
                  <span className="display-md">{s.name}</span>
                  <span className="caption muted">{s.sound}</span>
                </button>
              ))}
            </div>
          </section>
        )}

        {local && (
          <section className="section">
            <h2 className="display-md">Released in {scene.name}</h2>
            {sceneReleases.length ? (
              <div className="release-grid">
                {sceneReleases.map((r) => (
                  <ReleaseCard key={r.id} title={r.title} artist={artists.find((a) => a.id === r.artistId)?.name ?? ""} year={r.year} art={r.art} onOpen={() => go({ name: "artist", artistId: r.artistId })} />
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
