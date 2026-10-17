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
import { ShareButton } from "../components/ShareButton";
import { formatReleaseDate, shortReleaseDate } from "../components/ReleaseDate";
import { ReportButton } from "../components/ReportDialog";

const POPULAR_COUNT = 5;

/**
 * An artist's page, designed by the artist (their banner and lettering).
 * One page, top to bottom: their most-streamed songs, their
 * albums (newest first), then artists who sound like them. Artists edit their page on For artists, not here.
 */
export function ArtistPage({ artistId, go }: { artistId: string; go: Go }) {
  const p = usePlayer();
  const c = useCatalog();
  const artist = c.artistById[artistId];
  if (!artist) return <div className="screen"><p className="muted">Artist not found.</p></div>;

  // Albums, newest year first (same year: most recently added first).
  const albums = c.releases.filter((r) => r.artistId === artistId).sort((a, b) => b.year - a.year);
  const allTracks = albums.flatMap((r) => r.trackIds.map((id) => c.trackById[id]).filter(Boolean));
  const popular = mostStreamed(allTracks, c.streams).slice(0, POPULAR_COUNT);
  const coming = c.upcoming.filter((r) => r.artistId === artistId);
  const anyStreams = popular.some((t) => c.streams[t.id]);
  const playingThis = allTracks.some((t) => t.id === p.current?.id);
  const isMine = artistId === c.myProfile?.id;
  const similar = similarArtists([artist], c.artists, artistSounds(c.artists, c.tracks), 6);
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
          {allTracks.length > 0 && <PlayButton size="lg" playing={playingThis && p.playing} onClick={() => (playingThis ? p.toggle() : p.playQueue(popular.length ? popular : allTracks))} />}
          {!isMine && <FollowButton artist={artist} />}
          <Button variant="ghost" onClick={() => go({ name: "scenes", explore: { name: artist.city ?? city, state: artist.state ?? state ?? "", country: artist.country ?? "US" } })}>See the scene</Button>
          <ShareButton target={{ kind: "artist", id: artist.id }} label={artist.name} />
          {!isMine && <ReportButton artistId={artist.id} subject={artist.name} go={go} />}
        </div>
      </div>

      <div className="screen" style={{ paddingTop: 24 }}>
        {coming.length > 0 && (
          <section className="section">
            <div className="section-title" style={{ justifyContent: "space-between" }}>
              <h2 className="display-md">Coming soon</h2>
              <span className="caption muted">Next up: {formatReleaseDate(coming[0].releaseAt!)}</span>
            </div>
            <div className="release-grid">
              {coming.map((r) => (
                <ReleaseCard key={r.id} trackIds={r.trackIds} title={r.title} artist={r.kind} year={r.year} art={r.art} seed={sleeveSeed(r.title, artist.name)}
                  sticker={`Out ${shortReleaseDate(r.releaseAt!)}`} stickerTone="accent" onOpen={() => go({ name: "album", releaseId: r.id })} />
              ))}
            </div>
          </section>
        )}
        <section className="section">
          <div className="section-title" style={{ justifyContent: "space-between" }}>
            <h2 className="display-md">Popular</h2>
            <span className="caption muted">{anyStreams ? "Most streamed on Milk Crate." : "No streams yet. The most-streamed songs will show here."}</span>
          </div>
          {popular.length ? (
            <div>
              {popular.map((t, i) => {
                const release = c.releaseById[t.releaseId];
                return (
                  <div key={t.id} className="popular-row">
                    <Sleeve src={release?.art} seed={release ? sleeveSeed(release.title, artist.name) : t.title} style={{ width: 40, flex: "none" }} />
                    <div style={{ flex: "1 1 auto", minWidth: 0 }}>
                      <TrackRow trackId={t.id} index={i + 1} title={t.title} artist={release?.title} duration={formatTime(t.duration)} streams={c.streams[t.id] ?? 0}
                        favorite={p.isFavorite(t.id)} onFavorite={() => p.toggleFavorite(t.id)} playing={p.current?.id === t.id} paused={!p.playing} onToggle={p.toggle} onPlay={() => p.playQueue(popular, i)} actions={<AddToPlaylist trackIds={[t.id]} />} />
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="muted">No releases yet.</p>
          )}
        </section>

        {albums.length > 0 && (
          <section className="section">
            <h2 className="display-md">Albums <span className="muted" style={{ fontSize: "0.6em" }}>{albums.length}</span></h2>
            {albums.length ? (
              <div className="release-grid">
                {albums.map((r) => (
                  <ReleaseCard key={r.id} trackIds={r.trackIds} title={r.title} artist={r.kind} year={r.year} art={r.art} seed={sleeveSeed(r.title, artist.name)}
                    onOpen={() => go({ name: "album", releaseId: r.id })}
                    onPlay={() => p.playQueue(r.trackIds.map((id) => c.trackById[id]).filter(Boolean))} />
                ))}
              </div>
            ) : (
              <p className="muted">No releases yet.</p>
            )}
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

/** Most streams first; ties go to newer albums and earlier tracks (the order they're given in). */
export function mostStreamed(tracks: Track[], streams: Record<string, number>): Track[] {
  return tracks
    .map((t, order) => ({ t, order }))
    .sort((a, b) => (streams[b.t.id] ?? 0) - (streams[a.t.id] ?? 0) || a.order - b.order)
    .map((x) => x.t);
}
