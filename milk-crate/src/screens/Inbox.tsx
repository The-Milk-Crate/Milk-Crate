import { useEffect, useState } from "react";
import type { Go } from "../App";
import { useAlerts } from "../lib/alerts";
import { useCatalog } from "../lib/catalog";
import { usePlayer } from "../lib/player";
import { useLocation } from "../lib/location";
import { useLibrary } from "../lib/library";
import { Button, ReleaseCard } from "../components/ui";
import { shortReleaseDate } from "../components/ReleaseDate";

/** New: releases from artists you follow, new music from your scene, and what's coming soon. */
export function Inbox({ go }: { go: Go }) {
  const { alerts, coming, markSeen } = useAlerts();
  const c = useCatalog();
  const p = usePlayer();
  const lib = useLibrary();
  const { scene } = useLocation();
  // Keep showing which ones were new on this visit, then clear the badge.
  const [freshIds] = useState(() => new Set(alerts.filter((a) => a.unread).map((a) => a.release.id)));
  useEffect(() => { markSeen(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const card = (a: (typeof alerts)[number]) => {
    const r = a.release;
    const artist = c.artistById[r.artistId];
    return (
      <ReleaseCard key={r.id} trackIds={r.trackIds} title={r.title} artist={artist?.name ?? ""} place={artist?.place.split(",")[0]} year={r.year} art={r.art}
        sticker={freshIds.has(r.id) ? "New" : undefined}
        onOpen={() => go({ name: "album", releaseId: r.id })}
        onPlay={() => p.playQueue(r.trackIds.map((id) => c.trackById[id]).filter(Boolean))} />
    );
  };
  const followed = alerts.filter((a) => a.why === "following");
  const local = alerts.filter((a) => a.why === "scene");

  return (
    <div className="screen">
      <header style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <span className="catalog eyebrow">{freshIds.size ? `${freshIds.size} new since you last looked` : "You're caught up"}</span>
        <h1 className="display-lg">New For You</h1>
      </header>
      {coming.length > 0 && (
        <section className="section">
          <h2 className="display-md">Coming soon</h2>
          <div className="release-grid">
            {coming.map((r) => {
              const artist = c.artistById[r.artistId];
              return (
                <ReleaseCard key={r.id} trackIds={r.trackIds} title={r.title} artist={artist?.name ?? ""} place={artist?.place.split(",")[0]} year={r.year} art={r.art}
                  sticker={`Out ${shortReleaseDate(r.releaseAt!)}`} stickerTone="accent" onOpen={() => go({ name: "album", releaseId: r.id })} />
              );
            })}
          </div>
        </section>
      )}
      <section className="section">
        <h2 className="display-md">From artists you follow</h2>
        {followed.length ? (
          <div className="release-grid">{followed.map(card)}</div>
        ) : (
          <div className="empty">
            <span>{lib.following.length ? "Nothing new from the artists you follow in the last two months." : "Follow artists and their new releases show up here first."}</span>
            {!lib.following.length && <Button size="sm" onClick={() => go({ name: "artist" })}>Find artists</Button>}
          </div>
        )}
      </section>
      <section className="section">
        <h2 className="display-md">New from {scene ? `around ${scene.home.name}` : "your scene"}</h2>
        {local.length ? (
          <div className="release-grid">{local.map(card)}</div>
        ) : (
          <div className="empty"><span>No new releases from your scene this month.</span><Button size="sm" onClick={() => go({ name: "scenes" })}>Flip through your scene</Button></div>
        )}
      </section>
    </div>
  );
}
