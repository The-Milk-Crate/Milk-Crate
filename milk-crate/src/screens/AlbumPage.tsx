import { useState } from "react";
import { Check, Plus } from "lucide-react";
import type { Go } from "../App";
import { useCatalog } from "../lib/catalog";
import { usePlayer } from "../lib/player";
import { FORMAT_LABEL, attempt, useLibrary } from "../lib/library";
import { formatTime } from "../lib/format";
import { sleeveSeed } from "../lib/sleeve";
import type { PhysicalFormat } from "../lib/types";
import { Button, PlayButton, ReleaseCard, Sleeve, TrackRow } from "../components/ui";
import { AddToPlaylist } from "../components/AddToPlaylist";

const FORMATS: PhysicalFormat[] = ["LP", "7in", "Cassette", "CD"];

/** One album: play it start to finish, save it to your crate, mark a physical copy you own. Ratings shown are everyone's average. */
export function AlbumPage({ releaseId, go }: { releaseId: string; go: Go }) {
  const c = useCatalog();
  const p = usePlayer();
  const lib = useLibrary();
  const [owning, setOwning] = useState(false);
  const [msg, setMsg] = useState("");
  const release = c.releaseById[releaseId];
  if (!release) return <div className="screen"><p className="muted">Album not found.</p></div>;
  const artist = c.artistById[release.artistId];
  const tracks = release.trackIds.map((id) => c.trackById[id]).filter(Boolean);
  const total = tracks.reduce((s, t) => s + t.duration, 0);
  const thisPlaying = tracks.some((t) => t.id === p.current?.id);
  const saved = lib.isSaved(release.id);
  const owned = lib.physical.filter((x) => x.releaseId === release.id);
  const more = c.releases.filter((r) => r.artistId === release.artistId && r.id !== release.id);

  const addPhysical = (format: PhysicalFormat) => {
    setOwning(false);
    void attempt(async () => {
      await lib.addPhysical({ format, releaseId: release.id });
      setMsg(`Added your ${FORMAT_LABEL[format]} to your crate. The digital album is in there too.`);
    }, setMsg);
  };

  return (
    <div className="screen">
      <header className="album-head">
        <Sleeve src={release.art} seed={sleeveSeed(release.title, artist?.name ?? "")} alt={`${release.title} cover`} style={{ width: 240, flex: "none", boxShadow: "var(--shadow-lift)" }} />
        <div style={{ display: "flex", flexDirection: "column", gap: 10, minWidth: 0, flex: "1 1 320px" }}>
          <span className="catalog eyebrow">{[release.kind, release.year, release.catalogNumber && `CAT# ${release.catalogNumber}`].filter(Boolean).join(" · ")}</span>
          <h1 className="display-xl" style={{ overflowWrap: "anywhere" }}>{release.title}</h1>
          {artist && (
            <p className="muted">
              <button type="button" className="link-btn" style={{ fontWeight: 650, fontSize: 16 }} onClick={() => go({ name: "artist", artistId: artist.id })}>{artist.name}</button>
              {" · "}{artist.place} · {tracks.length} {tracks.length === 1 ? "song" : "songs"}, {formatTime(total)}
            </p>
          )}
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12, marginTop: 8 }}>
            {tracks.length > 0 && <PlayButton size="lg" playing={thisPlaying && p.playing} onClick={() => (thisPlaying ? p.toggle() : p.playQueue(tracks))} />}
            <Button variant={saved ? "ghost" : "primary"} onClick={() => void attempt(() => (saved ? lib.unsave(release.id) : lib.save(release.id)), setMsg)}>
              {saved ? <><Check size={16} aria-hidden="true" /> In your crate</> : <><Plus size={16} aria-hidden="true" /> Add to your crate</>}
            </Button>
            <Button variant="ghost" onClick={() => (lib.signedIn ? setOwning((o) => !o) : void attempt(() => lib.addPhysical({ format: "LP", releaseId: release.id })))} aria-expanded={owning}>
              I own this on…
            </Button>
            {tracks.length > 0 && <AddToPlaylist trackIds={tracks.map((t) => t.id)} label="Add all to a playlist" compact={false} />}
          </div>
          {owning && (
            <div role="group" aria-label="Format you own" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {FORMATS.map((f) => <button key={f} type="button" className="chip" onClick={() => addPhysical(f)}>{FORMAT_LABEL[f]}</button>)}
            </div>
          )}
          {owned.length > 0 && <p className="caption muted">On your shelf: {owned.map((o) => FORMAT_LABEL[o.format]).join(", ")}</p>}
          {saved && <button type="button" className="link-btn caption" style={{ alignSelf: "flex-start" }} onClick={() => go({ name: "crate", releaseId: release.id })}>Rate these songs in your crate</button>}
          {msg && <p className="form-info" role="status">{msg}</p>}
        </div>
      </header>

      <section className="section">
        <div className="section-title" style={{ justifyContent: "space-between" }}>
          <h2 className="display-md">Songs</h2>
          <span className="caption muted">Stars are the average from everyone on Milk Crate.</span>
        </div>
        <div>
          {tracks.map((t, i) => (
            <TrackRow key={t.id} index={i + 1} title={t.title} duration={formatTime(t.duration)} average={c.averages[t.id] ?? null}
              playing={p.current?.id === t.id} onPlay={() => p.playQueue(tracks, i)} actions={<AddToPlaylist trackIds={[t.id]} />} />
          ))}
        </div>
      </section>

      {more.length > 0 && artist && (
        <section className="section">
          <h2 className="display-md">More from {artist.name}</h2>
          <div className="release-grid">
            {more.map((r) => (
              <ReleaseCard key={r.id} title={r.title} artist={r.kind} year={r.year} art={r.art} seed={sleeveSeed(r.title, artist.name)}
                onOpen={() => go({ name: "album", releaseId: r.id })}
                onPlay={() => p.playQueue(r.trackIds.map((id) => c.trackById[id]).filter(Boolean))} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
