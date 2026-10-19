import { Tour } from "../components/Tour";
import { RadioButton } from "../components/RadioButton";
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
import { copyLabel, useFileCovers, useRippedForCrate } from "../lib/ripped";
import { sleeveSeed } from "../lib/sleeve";

const DAY = 86_400_000;

/** Home: your rotation, new releases, artists to discover, and what you've added lately. */
export function Home({ go }: { go: Go }) {
  const c = useCatalog();
  const p = usePlayer();
  const lib = useLibrary();
  const { scene } = useLocation();
  const placed = useArtistPlaces();
  const ripped = useRippedForCrate();
  const cdCovers = useFileCovers(ripped.map((a) => a.cover));

  const play = (r: Release) => p.playQueue(r.trackIds.map((id) => c.trackById[id]).filter(Boolean));
  const card = (r: Release, sticker?: string) => {
    const a = c.artistById[r.artistId];
    return (
      <ReleaseCard key={r.id} trackIds={r.trackIds} title={r.title} artist={a?.name ?? ""} place={a?.place.split(",")[0]} year={r.year} art={r.art}
        sticker={sticker} onOpen={() => go({ name: "album", releaseId: r.id })} onPlay={() => play(r)} />
    );
  };

  // In your rotation: albums you've played most in the last 30 days, CDs you ripped included.
  const cdByTrack = new Map(ripped.flatMap((a) => a.copies.flatMap((copy) => copy.tracks.map((t) => [t.id, a] as const))));
  const counts = new Map<string, number>();
  for (const h of p.history) {
    if (Date.now() - h.at >= 30 * DAY) continue;
    const key = c.releaseById[h.releaseId] ? h.releaseId : cdByTrack.has(h.trackId) ? `cd:${cdByTrack.get(h.trackId)!.key}` : null;
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const rippedByKey = new Map(ripped.map((a) => [`cd:${a.key}`, a]));
  const rotation = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([id]) => id);
  const rotationCard = (id: string) => {
    const cd = rippedByKey.get(id);
    if (!cd) return card(c.releaseById[id]);
    return (
      <ReleaseCard key={id} title={cd.title} artist={cd.artist} year={cd.year} art={cd.cover ? cdCovers[cd.cover] : undefined}
        seed={sleeveSeed(cd.title, cd.artist)} sticker={copyLabel(cd)} stickerTone="sticker"
        onOpen={() => go({ name: "computer", album: cd.key })} onPlay={() => p.playQueue(cd.tracks)} />
    );
  };

  // New releases: newest first, with ones from your scene marked.
  const nearIds = new Set(scene ? placed.filter((a) => inScene(scene, a.place)).map((a) => a.artist.id) : []);
  const fresh = c.releases.filter((r) => c.artistById[r.artistId]?.status === "approved").slice(0, 12);

  // Discover: sounds like who you follow, else up-and-coming artists around you.
  const followed = lib.following.map((id) => c.artistById[id]).filter(Boolean);
  const notFollowed = c.artists.filter((a) => !lib.isFollowing(a.id));
  const discover = followed.length
    ? similarArtists(followed, notFollowed, artistSounds(c.artists, c.tracks), 8).map((s) => ({ artist: s.artist, line: s.reason }))
    : notFollowed.filter((a) => nearIds.has(a.id)).sort((a, b) => b.since - a.since).slice(0, 8).map((a) => ({ artist: a, line: `New around ${scene?.home.name}` }));

  // Recently added to your crate: albums you saved and CDs you ripped, newest first.
  const added = [
    ...lib.saved.filter((s) => c.releaseById[s.releaseId]).map((s) => ({ id: s.releaseId, at: Date.parse(s.addedAt) || 0 })),
    ...ripped.map((a) => ({ id: `cd:${a.key}`, at: a.rippedAt })),
  ].sort((a, b) => b.at - a.at).slice(0, 8).map((x) => x.id);

  const hour = new Date().getHours();
  const hello = hour < 12 ? "Good Morning" : hour < 18 ? "Good Afternoon" : "Good Evening";

  return (
    <div className="screen">
      <header className="screen-head">
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <span className="catalog eyebrow">{scene ? `${scene.home.name}, ${scene.home.state}` : "Milk Crate"}</span>
          <h1 className="display-lg">{hello}{lib.displayName ? `, ${lib.displayName}` : ""}</h1>
          {scene && <div><RadioButton scene={scene} variant="primary" size="sm" /></div>}
        </div>
      </header>

      <Tour go={go} />
      {(
        <>
          <section className="section">
            <div className="section-title" style={{ justifyContent: "space-between" }}>
              <h2 className="display-md">In your rotation</h2>
            </div>
            {rotation.length ? <div className="release-grid">{rotation.map(rotationCard)}</div> : <p className="muted">Play some music and the albums you keep coming back to show up here.</p>}
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
              </div>
              <div className="release-grid">{discover.map((d) => <ArtistCard key={d.artist.id} artist={d.artist} line={d.line} go={go} />)}</div>
            </section>
          )}

          <section className="section">
            <h2 className="display-md">Recently added to your crate</h2>
            {added.length ? (
              <div className="release-grid">{added.map(rotationCard)}</div>
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
