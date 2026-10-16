import { useState } from "react";
import type { Go } from "../App";
import { formatTime } from "../lib/format";
import { EmptyCatalog } from "./Artists";
import { useCatalog } from "../lib/catalog";
import { useArtistPlaces, useLocation } from "../lib/location";
import { inScene } from "../lib/geo";
import { usePlayer } from "../lib/player";
import { pickAudioFiles } from "../lib/localFiles";
import { Button, ReleaseCard, Sticker, TrackRow } from "../components/ui";

export function Home({ go }: { go: Go }) {
  const p = usePlayer();
  const { artistById, releases, status } = useCatalog();
  const thisYear = new Date().getFullYear();
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const matches = releases.filter(
    (r) => !q || r.title.toLowerCase().includes(q) || artistById[r.artistId]?.name.toLowerCase().includes(q),
  );
  const { scene } = useLocation();
  const placed = useArtistPlaces();
  const inMyScene = new Set(scene ? placed.filter((a) => inScene(scene, a.place)).map((a) => a.artist.id) : []);
  const local = releases.filter((r) => inMyScene.has(r.artistId));
  const elsewhere = releases.filter((r) => !inMyScene.has(r.artistId) && artistById[r.artistId]?.status === "approved").slice(0, 10);
  const sceneName = scene?.home.name ?? "your scene";

  const openRelease = (releaseId: string) => {
    const r = releases.find((x) => x.id === releaseId)!;
    go({ name: "artist", artistId: r.artistId });
  };

  return (
    <div className="screen">
      <header className="screen-head">
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <span className="catalog eyebrow">{scene ? `${scene.home.name}, ${scene.home.state}` : "Milk Crate"}</span>
          <h1 className="display-lg">Dig in</h1>
        </div>
        <label className="field" style={{ flex: "0 1 360px", minWidth: 220 }}>
          <span className="catalog eyebrow">Search</span>
          <input type="search" placeholder="Artists, records, scenes" value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
      </header>

      {q ? (
        <section className="section">
          <h2 className="display-md">Results for “{query}”</h2>
          {matches.length ? (
            <div className="release-grid">
              {matches.map((r) => (
                <ReleaseCard key={r.id} title={r.title} artist={artistById[r.artistId]?.name ?? ""} year={r.year} art={r.art} onOpen={() => openRelease(r.id)} />
              ))}
            </div>
          ) : (
            <p className="muted">Nothing in the crates matches that yet.</p>
          )}
        </section>
      ) : (
        <>
          <section className="section">
            <div className="section-title">
              <h2 className="display-md">New from your scene</h2>
              <Sticker tone="dairy">{sceneName} & around</Sticker>
            </div>
            {local.length ? (
            <div className="release-grid">
              {local.map((r) => (
                <ReleaseCard
                  key={r.id}
                  title={r.title}
                  artist={artistById[r.artistId]?.name ?? ""}
                  art={r.art}
                  place={artistById[r.artistId]?.place.split(",")[0]}
                  year={r.year}
                  sticker={r.year === thisYear ? "New" : undefined}
                  onOpen={() => openRelease(r.id)}
                />
              ))}
            </div>
            ) : (
              <EmptyCatalog go={go} offline={status === "offline"} what={`No releases from around ${sceneName} yet.`} />
            )}
          </section>

          {elsewhere.length > 0 && (
            <section className="section">
              <div className="section-title">
                <h2 className="display-md">New across the country</h2>
                <button type="button" className="link-btn" onClick={() => go({ name: "scenes" })}>See every scene</button>
              </div>
              <div className="release-grid">
                {elsewhere.map((r) => (
                  <ReleaseCard key={r.id} title={r.title} artist={artistById[r.artistId]?.name ?? ""} art={r.art}
                    place={artistById[r.artistId]?.place} year={r.year} onOpen={() => openRelease(r.id)} />
                ))}
              </div>
            </section>
          )}

          <section className="section">
            <div className="section-title" style={{ justifyContent: "space-between" }}>
              <div>
                <h2 className="display-md">From your computer</h2>
                <p className="muted">Play your own files while the catalog is being built. Ratings here drive weighted shuffle.</p>
              </div>
              <div style={{ display: "flex", gap: 12 }}>
                {p.localTracks.length > 1 && (
                  <Button icon="play" onClick={() => p.shuffleAll(p.localTracks)}>Shuffle</Button>
                )}
                <Button variant="primary" onClick={async () => p.addLocalTracks(await pickAudioFiles())}>Add audio files</Button>
              </div>
            </div>
            {p.localTracks.length ? (
              <div>
                {p.localTracks.map((t, i) => (
                  <TrackRow
                    key={t.id}
                    index={i + 1}
                    title={t.title}
                    duration={t.duration ? formatTime(t.duration) : "—"}
                    rating={p.ratings[t.id]}
                    playing={p.current?.id === t.id}
                    onPlay={() => p.playQueue(p.localTracks, i)}
                    onRate={(v) => p.rate(t.id, v)}
                  />
                ))}
              </div>
            ) : (
              <div className="empty">
                <span>No files yet. MP3, FLAC, WAV, M4A and OGG all work.</span>
              </div>
            )}
          </section>

          {/* Shows near you: returns once artists can list their own shows. */}
        </>
      )}
    </div>
  );
}
