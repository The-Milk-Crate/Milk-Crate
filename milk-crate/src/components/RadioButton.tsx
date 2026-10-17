import { useMemo } from "react";
import { Radio } from "lucide-react";
import { useCatalog } from "../lib/catalog";
import { usePlayer } from "../lib/player";
import { useLibrary } from "../lib/library";
import { useArtistPlaces } from "../lib/location";
import { inScene, type Scene } from "../lib/geo";
import { radioBatch } from "../lib/radio";
import { Button } from "./ui";

/** Starts nonstop radio from a scene: its bands' songs, mixed (see lib/radio.ts). */
export function RadioButton({ scene, variant = "ghost", size }: { scene: Scene; variant?: "ghost" | "primary"; size?: "sm" }) {
  const c = useCatalog();
  const p = usePlayer();
  const lib = useLibrary();
  const placed = useArtistPlaces();
  const name = `${scene.home.name} radio`;
  const tracks = useMemo(() => {
    const artists = new Set(placed.filter((a) => inScene(scene, a.place)).map((a) => a.artist.id));
    const out = new Set(c.releases.map((r) => r.id));
    return c.tracks.filter((t) => artists.has(t.artistId) && out.has(t.releaseId));
  }, [placed, scene, c.releases, c.tracks]);
  if (!tracks.length) return null;
  const on = p.radio === name;

  const start = () =>
    p.startRadio(name, (avoid, lastArtist) =>
      radioBatch({
        tracks, releaseById: c.releaseById, streams: c.streams,
        favorites: new Set(lib.favorites), history: p.history.map((h) => h.trackId), exclude: avoid, lastArtist,
      }),
    );

  return (
    <Button variant={variant} size={size} onClick={on ? p.stopRadio : start} aria-pressed={on}
      title={on ? `Stop ${name} (what's queued keeps playing)` : `Nonstop music from ${scene.home.name}'s scene: new releases, favorites and bands you haven't heard yet`}>
      <Radio size={16} strokeWidth={1.75} aria-hidden="true" /> {on ? `${name} is on` : name}
    </Button>
  );
}
