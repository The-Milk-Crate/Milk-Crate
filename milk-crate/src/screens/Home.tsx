import { useState } from "react";
import type { Go } from "../App";
import { EmptyCatalog } from "./Artists";
import { useCatalog } from "../lib/catalog";
import { usePlayer } from "../lib/player";
import { useLibrary } from "../lib/library";
import { useArtistPlaces, useLocation } from "../lib/location";
import { inScene } from "../lib/geo";
import { artistSounds, similarArtists } from "../lib/similar";
import type { Release } from "../lib/types";
import { Button, ReleaseCard } from "../components/ui";
import { ArtistCard } from "../components/ArtistCard";

const DAY = 86_400_000;

/** Home: your rotation, new releases, artists to discover, and what you've added lately. */
export function Home({ go }: { go: Go }) {
  const c = useCatalog();
  const p = usePlayer();
  const lib = useLibrary();
  const { scene } = useLocation();
  const placed = useArtistPlaces();
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();

  const play = (r: Release) => p.playQueue(r.trackIds.map((id) => c.trackById[id]).filter(Boolean));
  const card = (r: Release, sticker?: string) => {
    const a = c.artistById[r.artistId];
    return (
      <ReleaseCard key={r.id} title={r.title} artist={a?.name ?? ""} place={a?.place.split(",")[0]} year={r.year} art={r.art}
        sticker={sticker} onOpen={() => go({ name: "album", releaseId: r.id })} onPlay={() => play(r)} />
    );
  };

  // In your rotation: albums you've played most in the last 30 days.
  const counts = new Map<string, number>();
  for (const h of p.history) if (Date.now() - h.at < 30 * DAY && c.releaseById[h.releaseId]) counts.set(h.releaseId, (counts.get(h.releaseId) ?? 0) + 1);
  const rotation = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([id]) => c.releaseById[id]);

  // New releases: newest first, with ones from your scene marked.
  const nearIds = new Set(scene ? placed.filter((a) => inScene(scene, a.place)).map((a) => a.artist.id) : []);
  const fresh = c.releases.filter((r) => c.artistById[r.artistId]?.status === "approved").slice(0, 12);

  // Discover: sounds like who you follow, else up-and-coming artists around you.
  const followed = lib.following.map((id) => c.artistById[id]).filter(Boolean);
  const notFollowed = c.artists.filter((a) => !lib.isFollowing(a.id));
  const discover = followed.length
    ? similarArtists(followed, notFollowed, artistSounds(c.artists, c.tracks), 8).map((s) => ({ artist: s.artist, line: s.reason }))
    : notFollowed.filter((a) => nearIds.has(a.id)).sort((a, b) => b.since - a.since).slice(0, 8).map((a) => ({ artist: a, line: `New around ${scene?.home.name}` }));

  // Recently added to your crate.
  const added = lib.saved.slice(0, 8).map((s) => c.releaseById[s.releaseId]).filter(Boolean);

  const matches = q
    ? c.releases.filter((r) => r.title.toLowerCase().includes(q) || c.artistById[r.artistId]?.name.toLowerCase().includes(q))
    : [];
  const artistMatches = q ? c.artists.filter((a) => a.name.toLowerCase().includes(q) || a.genres.some((g) => g.toLowerCase().includes(q))) : [];
  const hour = new Date().getHours();
  const hello = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";

  return (
    <div className="screen">
      <header className="screen-head">
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <span className="catalog eyebrow">{scene ? `${scene.home.name}, ${scene.home.state}` : "Milk Crate"}</span>
          <h1 className="display-lg">{hello}{lib.displayName ? `, ${lib.displayName}` : ""}</h1>
        </div>
        <label className="field" style={{ flex: "0 1 360px", minWidth: 220 }}>
          <span className="catalog eyebrow">Search</span>
          <input type="search" placeholder="Artists, albums, genres" value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
      </header>

      {q ? (
        <>
          {artistMatches.length > 0 && (
            <section className="section">
              <h2 className="display-md">Artists</h2>
              <div className="release-grid">{artistMatches.slice(0, 12).map((a) => <ArtistCard key={a.id} artist={a} go={go} />)}</div>
            </section>
          )}
          <section className="section">
            <h2 className="display-md">Albums matching “{query}”</h2>
            {matches.length ? <div className="release-grid">{matches.map((r) => card(r))}</div> : <p className="muted">Nothing in the crates matches that yet.</p>}
          </section>
        </>
      ) : (
        <>
          <section className="section">
            <div className="section-title" style={{ justifyContent: "space-between" }}>
              <h2 className="display-md">In your rotation</h2>
              {rotation.length > 0 && <button type="button" className="link-btn" onClick={() => go({ name: "crate" })}>Your crate</button>}
            </div>
            {rotation.length ? <div className="release-grid">{rotation.map((r) => card(r))}</div> : <p className="muted">Play some music and the albums you keep coming back to show up here.</p>}
          </section>

          <section className="section">
            <h2 className="display-md">New releases</h2>
            {fresh.length ? (
              <div className="release-grid">{fresh.map((r) => card(r, nearIds.has(r.artistId) ? "Near you" : undefined))}</div>
            ) : (
              <EmptyCatalog go={go} offline={c.status === "offline"} what="No releases on Milk Crate yet." />
            )}
          </section>

          {discover.length > 0 && (
            <section className="section">
              <div className="section-title" style={{ justifyContent: "space-between" }}>
                <h2 className="display-md">Discover</h2>
                <button type="button" className="link-btn" onClick={() => go({ name: "scenes" })}>Explore your scene</button>
              </div>
              <div className="release-grid">{discover.map((d) => <ArtistCard key={d.artist.id} artist={d.artist} line={d.line} go={go} />)}</div>
            </section>
          )}

          <section className="section">
            <h2 className="display-md">Recently added to your crate</h2>
            {added.length ? (
              <div className="release-grid">{added.map((r) => card(r))}</div>
            ) : (
              <div className="empty">
                <span>{lib.signedIn ? "Albums you add to your crate show up here." : "Sign in to start your crate: save albums, add your records and make playlists."}</span>
                {!lib.signedIn && <Button size="sm" variant="primary" onClick={() => go({ name: "account" })}>Sign in</Button>}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
