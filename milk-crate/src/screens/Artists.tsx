import type { Go } from "../App";
import { useCatalog } from "../lib/catalog";
import { sleeveSeed } from "../lib/sleeve";
import { Button, ReleaseCard } from "../components/ui";

/** Every artist on Milk Crate, newest first. No follower counts, no ranking. */
export function Artists({ go }: { go: Go }) {
  const { artists, releases, status } = useCatalog();
  const list = [...artists].reverse();

  return (
    <div className="screen">
      <header style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <span className="catalog eyebrow">{artists.length ? `${artists.length} on Milk Crate` : "Milk Crate"}</span>
        <h1 className="display-lg">Artists</h1>
        <p className="muted">Newest first. No follower counts.</p>
      </header>
      {list.length ? (
        <div className="release-grid">
          {list.map((a) => {
            const latest = releases.find((r) => r.artistId === a.id);
            return (
              <ReleaseCard
                key={a.id}
                title={a.name}
                artist={a.place.split(",")[0]}
                place={a.genres[0]}
                art={latest?.art}
                seed={latest ? sleeveSeed(latest.title, a.name) : a.name}
                onOpen={() => go({ name: "artist", artistId: a.id })}
              />
            );
          })}
        </div>
      ) : (
        <EmptyCatalog go={go} offline={status === "offline"} what="No artists on Milk Crate yet." />
      )}
    </div>
  );
}

/** Shown wherever the catalog has nothing yet. */
export function EmptyCatalog({ go, offline, what }: { go: Go; offline?: boolean; what: string }) {
  return (
    <div className="empty">
      <span>{offline ? "Can't reach the Milk Crate server right now. Check your internet connection." : `${what} Make an artist page and be the first.`}</span>
      {!offline && <Button size="sm" variant="primary" onClick={() => go({ name: "upload" })}>For artists</Button>}
    </div>
  );
}
