import { useState } from "react";
import { Check, Disc3, Plus } from "lucide-react";
import type { Go } from "../App";
import { useCatalog } from "../lib/catalog";
import { usePlayer } from "../lib/player";
import { FORMAT_LABEL, attempt, useLibrary } from "../lib/library";
import { formatTime } from "../lib/format";
import { sleeveSeed } from "../lib/sleeve";
import { isUpcoming, type PhysicalFormat } from "../lib/types";
import { formatReleaseDate, untilLabel } from "../components/ReleaseDate";
import { Button, DownloadedMark, PlayButton, ReleaseCard, Sleeve, TrackRow, useAllDownloaded } from "../components/ui";
import { AddToPlaylist } from "../components/AddToPlaylist";
import { ShareButton } from "../components/ShareButton";
import { ReportButton } from "../components/ReportDialog";
import { AlbumRating } from "../components/AlbumRating";

const FORMATS: PhysicalFormat[] = ["LP", "7in", "Cassette", "CD"];

/**
 * One album: play it start to finish, rate it out of five stars, save it to
 * your crate, favorite songs (the heart on each row), and (below the songs)
 * mark a physical copy you own.
 */
export function AlbumPage({ releaseId, go }: { releaseId: string; go: Go }) {
  const allDownloaded = useAllDownloaded(useCatalog().releaseById[releaseId]?.trackIds);
  const c = useCatalog();
  const p = usePlayer();
  const lib = useLibrary();
  const [owning, setOwning] = useState(false);
  const [msg, setMsg] = useState("");
  const [saveMsg, setSaveMsg] = useState("");
  const release = c.releaseById[releaseId];
  if (!release) return <div className="screen"><p className="muted">Album not found.</p></div>;
  const artist = c.artistById[release.artistId];
  const tracks = release.trackIds.map((id) => c.trackById[id]).filter(Boolean);
  const total = tracks.reduce((s, t) => s + t.duration, 0);
  const thisPlaying = tracks.some((t) => t.id === p.current?.id);
  const saved = lib.isSaved(release.id);
  const owned = lib.physical.filter((x) => x.releaseId === release.id);
  const more = c.releases.filter((r) => r.artistId === release.artistId && r.id !== release.id);
  const upcoming = isUpcoming(release);
  const isMine = !!artist && artist.id === c.myProfile?.id;

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
          <span className="catalog eyebrow">{[upcoming ? "Coming soon" : null, release.kind, release.year, release.catalogNumber && `CAT# ${release.catalogNumber}`].filter(Boolean).join(" · ")}</span>
          <h1 className="display-xl" style={{ overflowWrap: "anywhere" }}>{release.title}</h1>
          {artist && (
            <p className="muted">
              <button type="button" className="link-btn" style={{ fontWeight: 650, fontSize: 16 }} onClick={() => go({ name: "artist", artistId: artist.id })}>{artist.name}</button>
              {" · "}{artist.place}{tracks.length ? ` · ${tracks.length} ${tracks.length === 1 ? "song" : "songs"}, ${formatTime(total)}` : ""}
              {allDownloaded && <> · <DownloadedMark label="Album downloaded" /> Downloaded</>}
            </p>
          )}
          {upcoming ? (
            <p className="coming-banner" role="status">
              Out {formatReleaseDate(release.releaseAt!)} · {untilLabel(release.releaseAt!)}
            </p>
          ) : (
            <AlbumRating releaseId={release.id} />
          )}
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12, marginTop: 8 }}>
            {tracks.length > 0 && <PlayButton size="lg" playing={thisPlaying && p.playing} onClick={() => (thisPlaying ? p.toggle() : p.playQueue(tracks))} />}
            <Button variant={saved ? "ghost" : "primary"} onClick={() => void attempt(() => (saved ? lib.unsave(release.id) : lib.save(release.id)), setSaveMsg)}>
              {saved ? <><Check size={16} aria-hidden="true" /> In your crate</> : <><Plus size={16} aria-hidden="true" /> Add to your crate</>}
            </Button>
            {tracks.length > 0 && <AddToPlaylist trackIds={tracks.map((t) => t.id)} label="More" compact={false} />}
            <ShareButton target={{ kind: "album", id: release.id }} label={`${release.title}${artist ? ` by ${artist.name}` : ""}`} />
          </div>
          {artist && artist.id === c.myProfile?.id ? (
            <div><button type="button" className="link-btn caption" onClick={() => go({ name: "editRelease", releaseId: release.id })}>Edit this release</button></div>
          ) : (
            <div><ReportButton releaseId={release.id} artistId={artist?.id} subject={`${release.title}${artist ? ` by ${artist.name}` : ""}`} go={go} /></div>
          )}
          {saveMsg && <p className="form-info" role="status">{saveMsg}</p>}
        </div>
      </header>

      <section className="section">
        <div className="section-title" style={{ justifyContent: "space-between" }}>
          <h2 className="display-md">Songs</h2>
          <span className="caption muted">{upcoming ? (isMine ? `Only you can hear these until ${formatReleaseDate(release.releaseAt!)}.` : "") : "Tap the heart to put a song in your Favorites."}</span>
        </div>
        {upcoming && !tracks.length && (
          <div className="empty">
            <span>The songs unlock {formatReleaseDate(release.releaseAt!)}. {saved ? "It's in your crate, so it'll be ready." : "Add it to your crate and it'll be ready when it drops."}</span>
          </div>
        )}
        <div>
          {tracks.map((t, i) => (
            <TrackRow key={t.id} trackId={t.id} index={i + 1} title={t.title} duration={formatTime(t.duration)} favorite={p.isFavorite(t.id)} onFavorite={() => p.toggleFavorite(t.id)}
              playing={p.current?.id === t.id} paused={!p.playing} onToggle={p.toggle} onPlay={() => p.playQueue(tracks, i)} actions={<AddToPlaylist trackIds={[t.id]} />} />
          ))}
        </div>
        <div className="own-copy">
          <Button variant="ghost" aria-expanded={owning} aria-controls="own-formats"
            onClick={() => (lib.signedIn ? setOwning((o) => !o) : void attempt(() => lib.addPhysical({ format: "LP", releaseId: release.id })))}>
            <Disc3 size={16} aria-hidden="true" /> I own a physical copy
          </Button>
          {owned.length > 0 && !owning && <span className="caption muted">On your shelf: {owned.map((o) => FORMAT_LABEL[o.format]).join(", ")}</span>}
          {owning && (
            <div id="own-formats" role="group" aria-label="What do you own it on?" className="own-formats">
              <span className="caption muted">What do you own it on?</span>
              {FORMATS.map((f) => {
                const has = owned.some((o) => o.format === f);
                return (
                  <button key={f} type="button" className="chip" aria-pressed={has} disabled={has} onClick={() => addPhysical(f)}>
                    {has && <Check size={14} aria-hidden="true" />} {FORMAT_LABEL[f]}
                  </button>
                );
              })}
            </div>
          )}
          {msg && <p className="form-info" role="status" style={{ flexBasis: "100%" }}>{msg}</p>}
        </div>
      </section>

      {more.length > 0 && artist && (
        <section className="section">
          <h2 className="display-md">More from {artist.name}</h2>
          <div className="release-grid">
            {more.map((r) => (
              <ReleaseCard key={r.id} trackIds={r.trackIds} title={r.title} artist={r.kind} year={r.year} art={r.art} seed={sleeveSeed(r.title, artist.name)}
                onOpen={() => go({ name: "album", releaseId: r.id })}
                onPlay={() => p.playQueue(r.trackIds.map((id) => c.trackById[id]).filter(Boolean))} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
