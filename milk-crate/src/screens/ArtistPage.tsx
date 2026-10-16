import type { Go } from "../App";
import { formatTime } from "../lib/format";
import { useCatalog } from "../lib/catalog";
import { usePlayer } from "../lib/player";
import { sleeveSeed } from "../lib/sleeve";
import { Button, PlayButton, ReleaseCard, Sleeve, TrackRow } from "../components/ui";
import { ArtistBanner } from "../components/ArtistBanner";

/** An artist's page, designed by the artist: their banner and lettering up top, their music below. */
export function ArtistPage({ artistId, go }: { artistId: string; go: Go }) {
  const p = usePlayer();
  const { artistById, releases, trackById, myProfile } = useCatalog();
  const artist = artistById[artistId];
  if (!artist) return <div className="screen"><p className="muted">Artist not found.</p></div>;

  const discography = releases.filter((r) => r.artistId === artistId);
  const latest = discography[0];
  const tracks = latest ? latest.trackIds.map((id) => trackById[id]).filter(Boolean) : [];
  const playingThis = tracks.some((t) => t.id === p.current?.id) && p.playing;

  return (
    <div>
      {artist.status !== "approved" && (
        <p className="form-info" style={{ margin: "16px 16px 0" }}>
          Only you can see this page until your artist application is approved.
        </p>
      )}
      <ArtistBanner artist={artist} />
      <div className="artist-intro">
        {artist.bio && <p className="artist-bio">{artist.bio}</p>}
        <div className="artist-intro-actions">
          {tracks.length > 0 && (
            <PlayButton size="lg" playing={playingThis} onClick={() => (playingThis || tracks.some((t) => t.id === p.current?.id) ? p.toggle() : p.playQueue(tracks))} />
          )}
          {artistId === myProfile?.id ? (
            <Button onClick={() => go({ name: "upload" })}>Edit your page</Button>
          ) : (
            <Button>Follow</Button>
          )}
          <Button variant="ghost" onClick={() => go({ name: "scenes", explore: { name: artist.city ?? artist.place.split(",")[0].trim(), state: artist.state ?? artist.place.split(",")[1]?.trim() ?? "" } })}>See the scene</Button>
        </div>
      </div>

      <div className="screen" style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "flex-start", gap: 40 }}>
        <section className="section" style={{ flex: "999 1 480px", minWidth: 0 }}>
          {latest && (
            <>
              <div style={{ display: "flex", alignItems: "flex-end", gap: 20, flexWrap: "wrap" }}>
                <Sleeve src={latest.art} seed={sleeveSeed(latest.title, artist.name)} alt={`${latest.title} cover`} style={{ width: 132, flex: "none" }} />
                <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
                  <span className="catalog eyebrow">Latest · {latest.catalogNumber ? `CAT# ${latest.catalogNumber} · ` : ""}{latest.year} · {latest.kind}</span>
                  <h2 className="display-md">{latest.title}</h2>
                </div>
              </div>
              <div>
                {tracks.map((t, i) => (
                  <TrackRow
                    key={t.id}
                    index={i + 1}
                    title={t.title}
                    duration={formatTime(t.duration)}
                    rating={p.ratings[t.id]}
                    playing={p.current?.id === t.id}
                    onPlay={() => p.playQueue(tracks, i)}
                    onRate={(v) => p.rate(t.id, v)}
                  />
                ))}
              </div>
            </>
          )}
          {!latest && <p className="muted">No releases yet.</p>}
          {discography.length > 1 && <h2 className="display-md" style={{ marginTop: 24 }}>Discography</h2>}
          {discography.length > 1 && <div className="release-grid">
            {discography.map((r) => (
              <ReleaseCard key={r.id} title={r.title} artist={r.kind} year={r.year} art={r.art} seed={sleeveSeed(r.title, artist.name)} />
            ))}
          </div>}
        </section>

        {/* Buy direct (merch, vinyl) and On tour (shows) return here once artists can add them. */}
      </div>
    </div>
  );
}
