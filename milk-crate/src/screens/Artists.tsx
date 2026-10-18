import { useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import type { Go } from "../App";
import { useCatalog } from "../lib/catalog";
import { useLibrary } from "../lib/library";
import { load, save } from "../lib/storage";
import { artistSounds, similarArtists } from "../lib/similar";
import { discoveryOrder, discoverySet, today } from "../lib/discovery";
import { Button } from "../components/ui";
import { ArtistPanel } from "../components/ArtistPanel";

/** How many artists Discovery shows at a time. */
const DISCOVERY_SIZE = 4;

/**
 * Artists: everyone you follow as a wide panel (their own banner and lettering,
 * their releases underneath), then Discovery: artists you don't follow yet, a
 * few at a time and different each visit. Ones that sound like who you follow
 * come first.
 */
export function Artists({ go }: { go: Go }) {
  const c = useCatalog();
  const lib = useLibrary();
  const followedIds = lib.following.join("|");
  const followed = useMemo(() => lib.following.map((id) => c.artistById[id]).filter((a) => a && a.status === "approved"), [followedIds, c.artistById]); // eslint-disable-line react-hooks/exhaustive-deps
  const sounds = useMemo(() => artistSounds(c.artists, c.tracks), [c.artists, c.tracks]);
  const strangers = useMemo(() => c.artists.filter((a) => a.status === "approved" && !lib.following.includes(a.id)), [c.artists, followedIds]); // eslint-disable-line react-hooks/exhaustive-deps
  const suggestions = useMemo(() => (followed.length ? similarArtists(followed, strangers, sounds) : []), [followed, strangers, sounds]);
  const reasons = new Map(suggestions.map((s) => [s.artist.id, s.reason]));
  const order = useMemo(() => discoveryOrder(strangers, suggestions.map((s) => s.artist.id), today()), [strangers, suggestions]);
  // A different set each time you come back to the page, and on "Show me others".
  const [turn, setTurn] = useState(() => {
    const n = load<number>("mc.discoveryTurn", 0);
    save("mc.discoveryTurn", n + 1);
    return n;
  });
  const shown = discoverySet(order, turn, DISCOVERY_SIZE);

  return (
    <div className="screen">
      <header style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <span className="catalog eyebrow">{c.artists.length} on Milk Crate</span>
        <h1 className="display-lg">Artists</h1>
        <p className="muted">Who you follow, and who to hear next. No follower counts.</p>
      </header>

      <section className="section">
        <h2 className="display-md">Following</h2>
        {followed.length === 0 ? (
          <div className="empty">
            <span>{lib.signedIn ? "You're not following anyone yet. Follow artists from their pages, or from Discovery below." : "Sign in to follow artists and get suggestions that sound like them."}</span>
            {!lib.signedIn && <Button size="sm" variant="primary" onClick={() => go({ name: "account" })}>Sign in</Button>}
          </div>
        ) : (
          <div className="artist-panels">
            {followed.map((a) => <ArtistPanel key={a.id} artist={a} go={go} size="wide" />)}
          </div>
        )}
      </section>

      <section className="section">
        <div className="section-title" style={{ justifyContent: "space-between" }}>
          <h2 className="display-md">Discovery</h2>
          {order.length > DISCOVERY_SIZE && (
            <Button size="sm" onClick={() => setTurn((t) => t + 1)}><RefreshCw size={14} aria-hidden="true" /> Show me others</Button>
          )}
        </div>
        {shown.length ? (
          <div className="artist-panels is-grid">
            {shown.map((a) => <ArtistPanel key={a.id} artist={a} go={go} size="small" line={reasons.get(a.id)} />)}
          </div>
        ) : c.artists.length ? (
          <p className="muted">You follow everyone on Milk Crate. New artists show up here as they join.</p>
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
