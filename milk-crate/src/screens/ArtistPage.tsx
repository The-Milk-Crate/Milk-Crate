import type { Go } from "../App";
import { formatTime } from "../data/scenes";
import { useCatalog } from "../lib/catalog";
import { usePlayer } from "../lib/player";
import { sleeveSeed } from "../lib/sleeve";
import { PlayButton, ReleaseCard, Sleeve, TrackRow } from "../components/ui";

/** A customizable artist page: the header uses the artist's own accent; merch and tickets sell direct. */
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
      <header className="artist-head" style={{ background: artist.accent }}>
        <Sleeve src={latest?.art} seed={sleeveSeed(latest?.title ?? "", artist.name)} alt={latest ? `${latest.title} cover` : ""} />
        <div style={{ flex: "1 1 320px", minWidth: 0, display: "flex", flexDirection: "column", gap: 12 }}>
          <span className="catalog" style={{ textTransform: "uppercase" }}>
            Artist · {artist.place} · {artist.genres.join(", ")}
          </span>
          <h1 className="display-xl">{artist.name}</h1>
          <p style={{ maxWidth: 560, fontSize: 15, lineHeight: "22px" }}>{artist.bio}</p>
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12, marginTop: 8 }}>
            <PlayButton size="lg" playing={playingThis} onClick={() => (playingThis || tracks.some((t) => t.id === p.current?.id) ? p.toggle() : p.playQueue(tracks))} />
            {artistId === myProfile?.id ? (
              <button type="button" className="artist-btn" onClick={() => go({ name: "upload" })}>Edit your page</button>
            ) : (
              <button type="button" className="artist-btn">Follow</button>
            )}
            <button type="button" className="artist-btn" style={{ borderColor: "transparent" }} onClick={() => go({ name: "scenes", sceneId: artist.sceneId })}>
              See the scene
            </button>
          </div>
        </div>
      </header>

      <div className="screen" style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "flex-start", gap: 40 }}>
        <section className="section" style={{ flex: "999 1 480px", minWidth: 0 }}>
          {latest && (
            <>
              <div className="section-title" style={{ alignItems: "baseline" }}>
                <h2 className="display-md">{latest.title}</h2>
                <span className="catalog eyebrow">
                  {latest.catalogNumber ? `CAT# ${latest.catalogNumber} · ` : ""}{latest.year} · {latest.kind}
                </span>
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
