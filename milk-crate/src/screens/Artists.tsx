import type { Go } from "../App";
import { useCatalog } from "../lib/catalog";
import { useLibrary } from "../lib/library";
import { usePlayer } from "../lib/player";
import { sleeveSeed } from "../lib/sleeve";
import { artistSounds, similarArtists } from "../lib/similar";
import { Button, ReleaseCard } from "../components/ui";
import { ArtistCard, FollowButton } from "../components/ArtistCard";
import { ArtistThumb } from "../components/ArtistBanner";

/** Artists you follow (play straight from their albums), artists who sound like them, and everyone on Milk Crate. */
export function Artists({ go }: { go: Go }) {
  const c = useCatalog();
  const lib = useLibrary();
  const p = usePlayer();
  const followed = lib.following.map((id) => c.artistById[id]).filter((a) => a && a.status === "approved");
  const sounds = artistSounds(c.artists, c.tracks);
  const suggestions = followed.length ? similarArtists(followed, c.artists.filter((a) => !lib.isFollowing(a.id)), sounds) : [];
  const everyone = [...c.artists].reverse();

  return (
    <div className="screen">
      <header style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <span className="catalog eyebrow">{c.artists.length} on Milk Crate</span>
        <h1 className="display-lg">Artists</h1>
        <p className="muted">Who you follow, and who sounds like them. No follower counts.</p>
      </header>

      <section className="section">
        <h2 className="display-md">Following</h2>
        {followed.length === 0 ? (
          <div className="empty">
            <span>{lib.signedIn ? "You're not following anyone yet. Follow artists from their pages, or from the list below." : "Sign in to follow artists and get suggestions that sound like them."}</span>
            {!lib.signedIn && <Button size="sm" variant="primary" onClick={() => go({ name: "account" })}>Sign in</Button>}
          </div>
        ) : (
          followed.map((a) => {
            const albums = c.releases.filter((r) => r.artistId === a.id);
            return (
              <div key={a.id} className="followed-row">
                <div className="followed-head">
                  <ArtistThumb artist={a} size={56} />
                  <div style={{ flex: "1 1 auto", minWidth: 0, display: "flex", flexDirection: "column" }}>
                    <button type="button" className="link-btn" style={{ textAlign: "left", textDecoration: "none", color: "var(--ink)", fontWeight: 700, fontSize: 18 }}
                      onClick={() => go({ name: "artist", artistId: a.id })}>{a.name}</button>
                    <span className="caption muted">{[a.place, a.genres.join(", ")].filter(Boolean).join(" · ")}</span>
                  </div>
                  <FollowButton artist={a} small />
                </div>
                {albums.length > 0 ? (
                  <div className="followed-albums">
                    {albums.map((r) => (
                      <ReleaseCard key={r.id} trackIds={r.trackIds} title={r.title} artist={r.kind} year={r.year} art={r.art} seed={sleeveSeed(r.title, a.name)}
                        onOpen={() => go({ name: "album", releaseId: r.id })}
                        onPlay={() => p.playQueue(r.trackIds.map((id) => c.trackById[id]).filter(Boolean))} />
                    ))}
                  </div>
                ) : (
                  <p className="caption muted">No releases yet.</p>
                )}
              </div>
            );
          })
        )}
      </section>

      {suggestions.length > 0 && (
        <section className="section">
          <h2 className="display-md">Sounds like who you follow</h2>
          <div className="release-grid">
            {suggestions.map((s) => <ArtistCard key={s.artist.id} artist={s.artist} line={s.reason} go={go} />)}
          </div>
        </section>
      )}

      <section className="section">
        <h2 className="display-md">Everyone on Milk Crate</h2>
        {everyone.length ? (
          <div className="release-grid">
            {everyone.map((a) => <ArtistCard key={a.id} artist={a} go={go} />)}
          </div>
        ) : (
          <EmptyCatalog go={go} offline={c.status === "offline"} what="No artists on Milk Crate yet." />
        )}
      </section>
    </div>
  );
}

/** Shown wherever the catalog has nothing yet. */
export function EmptyCatalog({ go, offline, what }: { go: Go; offline?: boolean; what: string }) {
  return (
    <div className="empty">
      <span>{offline ? "Can't reach the Milk Crate server right now. Check your internet connection." : `${what} Make an artist page and be the first.`}</span>
      {!offline && <Button size="sm" variant="primary" onClick={() => go({ name: "upload" })}>For Artists</Button>}
    </div>
  );
}
