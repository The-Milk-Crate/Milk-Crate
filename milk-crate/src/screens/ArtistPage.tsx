import { useState } from "react";
import type { Go } from "../App";
import { formatTime } from "../lib/format";
import { useCatalog } from "../lib/catalog";
import { usePlayer } from "../lib/player";
import { sleeveSeed } from "../lib/sleeve";
import { artistSounds, similarArtists } from "../lib/similar";
import type { Track } from "../lib/types";
import { Button, PlayButton, ReleaseCard, Sleeve, TrackRow } from "../components/ui";
import { ArtistBanner } from "../components/ArtistBanner";
import { ArtistCard, FollowButton } from "../components/ArtistCard";
import { AddToPlaylist } from "../components/AddToPlaylist";

type Tab = "popular" | "albums" | "similar";
const POPULAR_COUNT = 5;

/**
 * An artist's page, designed by the artist (their banner and lettering).
 * Tabs: Popular (their top songs by listeners' star ratings), Albums (newest
 * first) and Sounds like. Artists edit their page on For artists, not here.
 */
export function ArtistPage({ artistId, go }: { artistId: string; go: Go }) {
  const p = usePlayer();
  const c = useCatalog();
  const [tab, setTab] = useState<Tab>("popular");
  const artist = c.artistById[artistId];
  if (!artist) return <div className="screen"><p className="muted">Artist not found.</p></div>;

  // Albums, newest year first (same year: most recently added first).
  const albums = c.releases.filter((r) => r.artistId === artistId).sort((a, b) => b.year - a.year);
  const allTracks = albums.flatMap((r) => r.trackIds.map((id) => c.trackById[id]).filter(Boolean));
  const popular = topRated(allTracks, c.averages, c.ratingCounts).slice(0, POPULAR_COUNT);
  const anyRated = popular.some((t) => c.averages[t.id]);
  const playingThis = allTracks.some((t) => t.id === p.current?.id);
  const isMine = artistId === c.myProfile?.id;
  const similar = similarArtists([artist], c.artists, artistSounds(c.artists, c.tracks), 6);
  const [city, state] = artist.place.split(",").map((x) => x.trim());
  const tabs: { id: Tab; label: string }[] = [
    { id: "popular", label: "Popular" },
    { id: "albums", label: `Albums${albums.length ? ` · ${albums.length}` : ""}` },
    ...(similar.length ? [{ id: "similar" as const, label: "Sounds like" }] : []),
  ];

  return (
    <div>
      {artist.status !== "approved" && (
        <p className="form-info" style={{ margin: "16px 16px 0" }}>Only you can see this page until your artist application is approved.</p>
      )}
      <ArtistBanner artist={artist} />
      <div className="artist-intro">
        {artist.bio && <p className="artist-bio">{artist.bio}</p>}
        <div className="artist-intro-actions">
          {allTracks.length > 0 && <PlayButton size="lg" playing={playingThis && p.playing} onClick={() => (playingThis ? p.toggle() : p.playQueue(popular.length ? popular : allTracks))} />}
          {!isMine && <FollowButton artist={artist} />}
          <Button variant="ghost" onClick={() => go({ name: "scenes", explore: { name: artist.city ?? city, state: artist.state ?? state ?? "" } })}>See the scene</Button>
        </div>
      </div>

      <div role="tablist" aria-label={`${artist.name}`} className="artist-tabs">
        {tabs.map((t) => (
          <button key={t.id} type="button" role="tab" id={`tab-${t.id}`} aria-selected={tab === t.id} aria-controls={`panel-${t.id}`} className="artist-tab" onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>

      <div className="screen" style={{ paddingTop: 24 }} role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === "popular" && (
          <section className="section">
            <div className="section-title" style={{ justifyContent: "space-between" }}>
              <h2 className="display-md">Popular</h2>
              <span className="caption muted">{anyRated ? "Ranked by listeners' star ratings." : "No ratings yet. Listeners' star ratings will rank these."}</span>
            </div>
            {popular.length ? (
              <div>
                {popular.map((t, i) => {
                  const release = c.releaseById[t.releaseId];
                  return (
                    <div key={t.id} className="popular-row">
                      <Sleeve src={release?.art} seed={release ? sleeveSeed(release.title, artist.name) : t.title} style={{ width: 40, flex: "none" }} />
                      <div style={{ flex: "1 1 auto", minWidth: 0 }}>
                        <TrackRow index={i + 1} title={t.title} artist={release?.title} duration={formatTime(t.duration)} average={c.averages[t.id] ?? null}
                          playing={p.current?.id === t.id} onPlay={() => p.playQueue(popular, i)} actions={<AddToPlaylist trackIds={[t.id]} />} />
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="muted">No releases yet.</p>
            )}
          </section>
        )}

        {tab === "albums" && (
          <section className="section">
            <h2 className="display-md">Albums</h2>
            {albums.length ? (
              <div className="release-grid">
                {albums.map((r) => (
                  <ReleaseCard key={r.id} title={r.title} artist={r.kind} year={r.year} art={r.art} seed={sleeveSeed(r.title, artist.name)}
                    onOpen={() => go({ name: "album", releaseId: r.id })}
                    onPlay={() => p.playQueue(r.trackIds.map((id) => c.trackById[id]).filter(Boolean))} />
                ))}
              </div>
            ) : (
              <p className="muted">No releases yet.</p>
            )}
          </section>
        )}

        {tab === "similar" && (
          <section className="section">
            <h2 className="display-md">Sounds like {artist.name}</h2>
            <div className="release-grid">
              {similar.map((s) => <ArtistCard key={s.artist.id} artist={s.artist} line={s.reason.replace(/^Sounds like [^:]+: /, "")} go={go} />)}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

/** Highest average rating first; ties go to the song more people rated, then to newer albums and earlier tracks. */
export function topRated(tracks: Track[], averages: Record<string, number>, counts: Record<string, number>): Track[] {
  return tracks
    .map((t, order) => ({ t, order }))
    .sort((a, b) => (averages[b.t.id] ?? 0) - (averages[a.t.id] ?? 0) || (counts[b.t.id] ?? 0) - (counts[a.t.id] ?? 0) || a.order - b.order)
    .map((x) => x.t);
}
