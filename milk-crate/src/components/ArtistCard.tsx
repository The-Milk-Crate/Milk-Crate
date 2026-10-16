import { Check, Plus } from "lucide-react";
import type { Go } from "../App";
import type { Artist } from "../lib/types";
import { useCatalog } from "../lib/catalog";
import { attempt, useLibrary } from "../lib/library";
import { sleeveSeed } from "../lib/sleeve";
import { Sleeve } from "./ui";

/** Follow or unfollow an artist. */
export function FollowButton({ artist, small }: { artist: Artist; small?: boolean }) {
  const lib = useLibrary();
  const on = lib.isFollowing(artist.id);
  return (
    <button type="button" className={`mc-btn ${small ? "mc-btn-sm" : ""} ${on ? "" : "mc-btn-primary"}`} aria-pressed={on}
      onClick={(e) => { e.stopPropagation(); void attempt(() => (on ? lib.unfollow(artist.id) : lib.follow(artist.id))); }}>
      {on ? <><Check size={14} aria-hidden="true" /> Following</> : <><Plus size={14} aria-hidden="true" /> Follow</>}
    </button>
  );
}

/** An artist as a card: their banner (or latest cover), name, a line of context, and Follow. */
export function ArtistCard({ artist, line, go }: { artist: Artist; line?: string; go: Go }) {
  const c = useCatalog();
  const latest = c.releases.find((r) => r.artistId === artist.id);
  const art = artist.page.bannerTall ?? artist.page.banner ?? latest?.art;
  return (
    <div className="artist-card">
      <a className="mc-card" href="#" onClick={(e) => { e.preventDefault(); go({ name: "artist", artistId: artist.id }); }}>
        <div className="mc-card-art">
          <Sleeve src={art} seed={latest ? sleeveSeed(latest.title, artist.name) : artist.name} alt="" />
        </div>
        <div>
          <div className="mc-card-title">{artist.name}</div>
          <div className="mc-card-meta">{line ?? [artist.place.split(",")[0], artist.genres[0]].filter(Boolean).join(" · ")}</div>
        </div>
      </a>
      <FollowButton artist={artist} small />
    </div>
  );
}
