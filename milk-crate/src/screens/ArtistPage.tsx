import type { Go } from "../App";
import { formatTime } from "../lib/format";
import { useCatalog } from "../lib/catalog";
import { usePlayer } from "../lib/player";
import { sleeveSeed } from "../lib/sleeve";
import { artistSounds, similarArtists } from "../lib/similar";
import { Button, PlayButton, ReleaseCard, Sleeve, TrackRow } from "../components/ui";
import { ArtistBanner } from "../components/ArtistBanner";
import { ArtistCard, FollowButton } from "../components/ArtistCard";
import { AddToPlaylist } from "../components/AddToPlaylist";

/**
 * An artist's page, designed by the artist (their banner and lettering), with
 * their albums. Star ratings here are the average from everyone on Milk Crate.
 * Artists edit their page on For artists, not here.
 */
export function ArtistPage({ artistId, go }: { artistId: string; go: Go }) {
  const p = usePlayer();
  const c = useCatalog();
  const artist = c.artistById[artistId];
  if (!artist) return <div className="screen"><p className="muted">Artist not found.</p></div>;

  const albums = c.releases.filter((r) => r.artistId === artistId);
  const latest = albums[0];
  const tracks = latest ? latest.trackIds.map((id) => c.trackById[id]).filter(Boolean) : [];
  const allTracks = albums.flatMap((r) => r.trackIds.map((id) => c.trackById[id]).filter(Boolean));
  const playingThis = allTracks.some((t) => t.id === p.current?.id);
  const isMine = artistId === c.myProfile?.id;
  const sounds = artistSounds(c.artists, c.tracks);
  const similar = similarArtists([artist], c.artists, sounds, 6);
  const [city, state] = artist.place.split(",").map((x) => x.trim());

  return (
    <div>
      {artist.status !== "approved" && (
        <p className="form-info" style={{ margin: "16px 16px 0" }}>Only you can see this page until your artist application is approved.</p>
      )}
      <ArtistBanner artist={artist} />
      <div className="artist-intro">
        {artist.bio && <p className="artist-bio">{artist.bio}</p>}
        <div className="artist-intro-actions">
          {allTracks.length > 0 && <PlayButton size="lg" playing={playingThis && p.playing} onClick={() => (playingThis ? p.toggle() : p.playQueue(tracks.length ? tracks : allTracks))} />}
          {!isMine && <FollowButton artist={artist} />}
          <Button variant="ghost" onClick={() => go({ name: "scenes", explore: { name: artist.city ?? city, state: artist.state ?? state ?? "" } })}>See the scene</Button>
        </div>
      </div>

      <div className="screen" style={{ gap: 40 }}>
        {albums.length === 0 && <p className="muted">No releases yet.</p>}
        {albums.length > 0 && (
          <section className="section">
            <h2 className="display-md">Albums</h2>
            <div className="release-grid">
              {albums.map((r) => (
                <ReleaseCard key={r.id} title={r.title} artist={r.kind} year={r.year} art={r.art} seed={sleeveSeed(r.title, artist.name)}
                  onOpen={() => go({ name: "album", releaseId: r.id })}
                  onPlay={() => p.playQueue(r.trackIds.map((id) => c.trackById[id]).filter(Boolean))} />
              ))}
            </div>
          </section>
        )}

        {latest && tracks.length > 0 && (
          <section className="section">
            <div style={{ display: "flex", alignItems: "flex-end", gap: 20, flexWrap: "wrap" }}>
              <Sleeve src={latest.art} seed={sleeveSeed(latest.title, artist.name)} alt={`${latest.title} cover`} style={{ width: 96, flex: "none" }} />
              <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0, flex: "1 1 auto" }}>
                <span className="catalog eyebrow">Latest · {latest.year} · {latest.kind}</span>
                <button type="button" className="link-btn display-md" style={{ textAlign: "left", textDecoration: "none", color: "var(--ink)" }} onClick={() => go({ name: "album", releaseId: latest.id })}>{latest.title}</button>
              </div>
              <span className="caption muted">Stars: average from everyone</span>
            </div>
            <div>
              {tracks.map((t, i) => (
                <TrackRow key={t.id} index={i + 1} title={t.title} duration={formatTime(t.duration)} average={c.averages[t.id] ?? null}
                  playing={p.current?.id === t.id} onPlay={() => p.playQueue(tracks, i)} actions={<AddToPlaylist trackIds={[t.id]} />} />
              ))}
            </div>
          </section>
        )}

        {similar.length > 0 && (
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
