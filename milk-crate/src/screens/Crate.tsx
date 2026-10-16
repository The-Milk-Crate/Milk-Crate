import { useMemo, useState } from "react";
import { Shuffle, Trash2, X } from "lucide-react";
import type { CrateTab, Go } from "../App";
import { useCatalog } from "../lib/catalog";
import { usePlayer } from "../lib/player";
import { FORMAT_LABEL, attempt, useLibrary, type PhysicalItem } from "../lib/library";
import { pickAudioFiles } from "../lib/localFiles";
import { formatTime } from "../lib/format";
import { sleeveSeed } from "../lib/sleeve";
import type { PhysicalFormat, Track } from "../lib/types";
import { Button, PlayButton, ReleaseCard, Sleeve, TrackRow } from "../components/ui";
import { AddToPlaylist } from "../components/AddToPlaylist";

const FORMATS: PhysicalFormat[] = ["LP", "7in", "Cassette", "CD"];

/**
 * Your Crate: albums you've saved, your records, tapes and CDs, playlists, and
 * audio files from your computer. Your own star ratings live here.
 */
export function Crate({ go, tab = "albums", releaseId, playlistId }: { go: Go; tab?: CrateTab; releaseId?: string; playlistId?: string }) {
  if (releaseId) return <CrateAlbum go={go} releaseId={releaseId} />;
  if (playlistId) return <CratePlaylist go={go} playlistId={playlistId} />;
  return <CrateHome go={go} tab={tab} />;
}

function useLibraryTracks() {
  const c = useCatalog();
  const lib = useLibrary();
  const p = usePlayer();
  return useMemo(() => {
    const fromAlbums = lib.saved.flatMap((s) => c.releaseById[s.releaseId]?.trackIds.map((id) => c.trackById[id]) ?? []).filter(Boolean) as Track[];
    return [...fromAlbums, ...p.localTracks];
  }, [lib.saved, c.releaseById, c.trackById, p.localTracks]);
}

function CrateHome({ go, tab }: { go: Go; tab: CrateTab }) {
  const c = useCatalog();
  const p = usePlayer();
  const lib = useLibrary();
  const all = useLibraryTracks();
  const albums = lib.saved.map((s) => c.releaseById[s.releaseId]).filter(Boolean);
  const shelf = lib.physical.length;
  const tabs: { id: CrateTab; label: string; count: number }[] = [
    { id: "albums", label: "Albums", count: albums.length },
    { id: "physical", label: "Physical media", count: shelf },
    { id: "playlists", label: "Playlists", count: lib.playlists.length },
    { id: "files", label: "On this computer", count: p.localTracks.length },
  ];

  return (
    <div className="screen">
      <header className="screen-head">
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <span className="catalog eyebrow">{albums.length} {albums.length === 1 ? "album" : "albums"} · {shelf} on your shelf · {lib.playlists.length} {lib.playlists.length === 1 ? "playlist" : "playlists"}</span>
          <h1 className="display-lg">Your Crate</h1>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
          <Button variant="primary" onClick={() => p.shuffleAll(all)} disabled={!all.length}>
            <Shuffle size={16} aria-hidden="true" /> Shuffle your library
          </Button>
        </div>
      </header>

      {!lib.signedIn && (
        <div className="empty">
          <span>Your crate lives in your account, so it's with you on any computer. Sign in or create a free listener account to save albums, add your records and make playlists.</span>
          <Button size="sm" variant="primary" onClick={() => go({ name: "account" })}>Sign in</Button>
        </div>
      )}

      <div role="tablist" aria-label="Your crate" className="segmented">
        {tabs.map((t) => (
          <button key={t.id} type="button" role="tab" className="chip" aria-selected={tab === t.id} aria-pressed={tab === t.id} onClick={() => go({ name: "crate", tab: t.id })}>
            {t.label} <span className="muted" style={{ fontWeight: 450 }}>{t.count}</span>
          </button>
        ))}
      </div>

      {tab === "albums" && (
        albums.length ? (
          <div className="release-grid">
            {albums.map((r) => {
              const a = c.artistById[r.artistId];
              const formats = lib.physical.filter((x) => x.releaseId === r.id).map((x) => x.format);
              return (
                <ReleaseCard key={r.id} title={r.title} artist={a?.name ?? ""} year={r.year} art={r.art}
                  sticker={formats.length ? formats.map((f) => (f === "7in" ? '7"' : f)).join(" + ") : undefined} stickerTone="sticker"
                  onOpen={() => go({ name: "crate", releaseId: r.id })}
                  onPlay={() => p.playQueue(r.trackIds.map((id) => c.trackById[id]).filter(Boolean))} />
              );
            })}
          </div>
        ) : (
          lib.signedIn && <div className="empty"><span>No albums yet. Open any album and choose "Add to your crate", or add a record you own under Physical media.</span><Button size="sm" onClick={() => go({ name: "home" })}>Find music</Button></div>
        )
      )}

      {tab === "physical" && <PhysicalShelf go={go} />}
      {tab === "playlists" && <PlaylistList go={go} />}
      {tab === "files" && <LocalFiles />}
    </div>
  );
}

/* ---------- Physical media ---------- */

function PhysicalShelf({ go }: { go: Go }) {
  const c = useCatalog();
  const lib = useLibrary();
  const [format, setFormat] = useState<PhysicalFormat>("LP");
  const [query, setQuery] = useState("");
  const [manual, setManual] = useState(false);
  const [artistName, setArtistName] = useState("");
  const [title, setTitle] = useState("");
  const [msg, setMsg] = useState<{ kind: "info" | "error"; text: string } | null>(null);

  const q = query.trim().toLowerCase();
  const matches = q.length > 1
    ? c.releases.filter((r) => r.title.toLowerCase().includes(q) || c.artistById[r.artistId]?.name.toLowerCase().includes(q)).slice(0, 6)
    : [];

  const add = (item: Parameters<typeof lib.addPhysical>[0], label: string) =>
    void attempt(async () => {
      await lib.addPhysical(item);
      setMsg({ kind: "info", text: item.releaseId ? `Added ${label} (${FORMAT_LABEL[item.format]}). It's on Milk Crate, so the digital album is in your crate too.` : `Added ${label} (${FORMAT_LABEL[item.format]}).` });
      setQuery(""); setArtistName(""); setTitle(""); setManual(false);
    }, (m) => setMsg({ kind: "error", text: m }));

  const groups = FORMATS.map((f) => ({ format: f, items: lib.physical.filter((x) => x.format === f) })).filter((g) => g.items.length);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      <section className="panel">
        <h2 className="display-md">Add a record, tape or CD</h2>
        <div role="group" aria-label="Format" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {FORMATS.map((f) => <button key={f} type="button" className="chip" aria-pressed={format === f} onClick={() => setFormat(f)}>{FORMAT_LABEL[f]}</button>)}
        </div>
        {!manual ? (
          <>
            <label className="field">
              <span className="catalog eyebrow">Find it on Milk Crate</span>
              <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Album or artist" />
            </label>
            {matches.length > 0 && (
              <div className="pick-list">
                {matches.map((r) => {
                  const a = c.artistById[r.artistId];
                  return (
                    <button key={r.id} type="button" className="pick-row" onClick={() => add({ format, releaseId: r.id }, r.title)}>
                      <Sleeve src={r.art} seed={sleeveSeed(r.title, a?.name ?? "")} style={{ width: 40, flex: "none" }} />
                      <span style={{ flex: "1 1 auto", minWidth: 0 }}><strong>{r.title}</strong><span className="caption muted"> · {a?.name} · {r.year}</span></span>
                      <span className="caption">Add as {FORMAT_LABEL[format]}</span>
                    </button>
                  );
                })}
              </div>
            )}
            {q.length > 1 && matches.length === 0 && <p className="caption muted">Not on Milk Crate yet.</p>}
            <button type="button" className="link-btn caption" style={{ alignSelf: "flex-start" }} onClick={() => setManual(true)}>Not on Milk Crate? Add it by hand</button>
          </>
        ) : (
          <>
            <div className="form-grid">
              <label className="field"><span className="catalog eyebrow">Artist</span><input value={artistName} onChange={(e) => setArtistName(e.target.value)} /></label>
              <label className="field"><span className="catalog eyebrow">Title</span><input value={title} onChange={(e) => setTitle(e.target.value)} /></label>
            </div>
            <div style={{ display: "flex", gap: 12 }}>
              <Button variant="primary" disabled={!title.trim()} onClick={() => add({ format, artistName: artistName.trim(), title: title.trim() }, title.trim())}>Add to your shelf</Button>
              <Button variant="ghost" onClick={() => setManual(false)}>Search Milk Crate instead</Button>
            </div>
          </>
        )}
        <p className="caption muted">Scanning a barcode is coming soon.</p>
        {msg && <p role={msg.kind === "error" ? "alert" : "status"} className={msg.kind === "error" ? "form-error" : "form-info"}>{msg.text}</p>}
      </section>

      {groups.map((g) => (
        <section key={g.format} className="section" style={{ gap: 8 }}>
          <h2 className="display-md">{FORMAT_LABEL[g.format]}{g.items.length > 1 ? "s" : ""}</h2>
          {g.items.map((item) => <ShelfRow key={item.id} item={item} go={go} />)}
        </section>
      ))}
    </div>
  );
}

function ShelfRow({ item, go }: { item: PhysicalItem; go: Go }) {
  const c = useCatalog();
  const lib = useLibrary();
  const release = item.releaseId ? c.releaseById[item.releaseId] : undefined;
  return (
    <div className="list-row">
      <Sleeve src={release?.art} seed={sleeveSeed(item.title, item.artistName)} style={{ width: 48, flex: "none" }} />
      <div style={{ flex: "1 1 auto", minWidth: 0, display: "flex", flexDirection: "column" }}>
        <span style={{ fontWeight: 650 }}>{release?.title ?? item.title}</span>
        <span className="caption muted">{(release && c.artistById[release.artistId]?.name) || item.artistName}</span>
      </div>
      {release ? (
        <button type="button" className="link-btn caption" onClick={() => go({ name: "crate", releaseId: release.id })}>Digital copy in your crate</button>
      ) : (
        <span className="caption muted">Not on Milk Crate yet</span>
      )}
      <button type="button" className="mc-icon-btn" aria-label={`Remove ${item.title}`} onClick={() => void attempt(() => lib.removePhysical(item.id))}>
        <Trash2 size={16} strokeWidth={1.75} aria-hidden="true" />
      </button>
    </div>
  );
}

/* ---------- Playlists ---------- */

function PlaylistList({ go }: { go: Go }) {
  const c = useCatalog();
  const p = usePlayer();
  const lib = useLibrary();
  const [name, setName] = useState("");
  const tracksOf = (ids: string[]) => ids.map((id) => c.trackById[id]).filter(Boolean);

  const create = () => void attempt(async () => {
    const pl = await lib.createPlaylist(name.trim() || `New playlist ${lib.playlists.length + 1}`);
    setName("");
    go({ name: "crate", playlistId: pl.id });
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <form className="panel" style={{ flexDirection: "row", alignItems: "flex-end", flexWrap: "wrap" }} onSubmit={(e) => { e.preventDefault(); create(); }}>
        <label className="field" style={{ flex: "1 1 260px" }}>
          <span className="catalog eyebrow">New playlist</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name it" maxLength={100} />
        </label>
        <Button variant="primary" type="submit">Create</Button>
      </form>
      {lib.playlists.length === 0 && lib.signedIn && <p className="muted">No playlists yet. Add songs to one from any album with the playlist button.</p>}
      {lib.playlists.map((pl) => {
        const tracks = tracksOf(pl.trackIds);
        return (
          <div key={pl.id} className="list-row">
            <PlayButton playing={false} onClick={() => p.playQueue(tracks)} />
            <button type="button" className="link-btn" style={{ flex: "1 1 auto", textAlign: "left", textDecoration: "none", color: "var(--ink)", fontWeight: 650 }}
              onClick={() => go({ name: "crate", playlistId: pl.id })}>{pl.name}</button>
            <span className="caption muted">{tracks.length} {tracks.length === 1 ? "song" : "songs"} · {formatTime(tracks.reduce((s, t) => s + t.duration, 0))}</span>
          </div>
        );
      })}
    </div>
  );
}

function CratePlaylist({ go, playlistId }: { go: Go; playlistId: string }) {
  const c = useCatalog();
  const p = usePlayer();
  const lib = useLibrary();
  const pl = lib.playlists.find((x) => x.id === playlistId);
  const [name, setName] = useState(pl?.name ?? "");
  const [confirmDelete, setConfirmDelete] = useState(false);
  if (!pl) return <div className="screen"><p className="muted">Playlist not found.</p><Button onClick={() => go({ name: "crate", tab: "playlists" })}>Back to playlists</Button></div>;
  const tracks = pl.trackIds.map((id) => c.trackById[id]);
  const playable = tracks.filter(Boolean) as Track[];

  return (
    <div className="screen">
      <button type="button" className="link-btn caption" style={{ alignSelf: "flex-start" }} onClick={() => go({ name: "crate", tab: "playlists" })}>← Your playlists</button>
      <header className="screen-head">
        <div style={{ display: "flex", flexDirection: "column", gap: 8, flex: "1 1 360px" }}>
          <span className="catalog eyebrow">Playlist · {playable.length} songs · {formatTime(playable.reduce((s, t) => s + t.duration, 0))}</span>
          <input className="title-input display-lg" value={name} aria-label="Playlist name" maxLength={100}
            onChange={(e) => setName(e.target.value)} onBlur={() => name.trim() !== pl.name && void attempt(() => lib.renamePlaylist(pl.id, name))}
            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} />
        </div>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
          <PlayButton size="lg" playing={false} onClick={() => p.playQueue(playable)} />
          <Button onClick={() => p.shuffleAll(playable)} disabled={!playable.length}><Shuffle size={16} aria-hidden="true" /> Shuffle</Button>
          {confirmDelete ? (
            <Button variant="ghost" onClick={() => void attempt(async () => { await lib.deletePlaylist(pl.id); go({ name: "crate", tab: "playlists" }); })}>Delete for good</Button>
          ) : (
            <Button variant="ghost" onClick={() => setConfirmDelete(true)}>Delete playlist</Button>
          )}
        </div>
      </header>
      {tracks.length === 0 && <p className="muted">Empty for now. Open any album and use the playlist button next to a song.</p>}
      <div>
        {tracks.map((t, i) =>
          t ? (
            <TrackRow key={`${t.id}-${i}`} index={i + 1} title={t.title} artist={c.artistById[t.artistId]?.name} duration={formatTime(t.duration)}
              rating={p.ratings[t.id]} onRate={(v) => p.rate(t.id, v)} playing={p.current?.id === t.id}
              onPlay={() => p.playQueue(playable, playable.indexOf(t))}
              actions={<button type="button" className="mc-icon-btn" aria-label={`Remove ${t.title} from playlist`} onClick={() => void attempt(() => lib.removeFromPlaylist(pl.id, i))}><X size={16} aria-hidden="true" /></button>} />
          ) : null,
        )}
      </div>
    </div>
  );
}

/* ---------- One album in your crate (with your ratings) ---------- */

function CrateAlbum({ go, releaseId }: { go: Go; releaseId: string }) {
  const c = useCatalog();
  const p = usePlayer();
  const lib = useLibrary();
  const r = c.releaseById[releaseId];
  if (!r) return <div className="screen"><p className="muted">Album not found.</p></div>;
  const a = c.artistById[r.artistId];
  const tracks = r.trackIds.map((id) => c.trackById[id]).filter(Boolean);
  const owned = lib.physical.filter((x) => x.releaseId === r.id);
  const saved = lib.isSaved(r.id);

  return (
    <div className="screen">
      <button type="button" className="link-btn caption" style={{ alignSelf: "flex-start" }} onClick={() => go({ name: "crate", tab: "albums" })}>← Your crate</button>
      <header className="album-head">
        <Sleeve src={r.art} seed={sleeveSeed(r.title, a?.name ?? "")} alt={`${r.title} cover`} style={{ width: 200, flex: "none" }} />
        <div style={{ display: "flex", flexDirection: "column", gap: 10, flex: "1 1 320px", minWidth: 0 }}>
          <span className="catalog eyebrow">In your crate{owned.length ? ` · on your shelf as ${owned.map((o) => FORMAT_LABEL[o.format]).join(", ")}` : ""}</span>
          <h1 className="display-lg">{r.title}</h1>
          <p className="muted">{a?.name} · {r.kind} · {r.year}</p>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
            <PlayButton size="lg" playing={false} onClick={() => p.playQueue(tracks)} />
            <Button onClick={() => go({ name: "album", releaseId: r.id })}>Album page</Button>
            {saved && <Button variant="ghost" onClick={() => void attempt(async () => { await lib.unsave(r.id); go({ name: "crate", tab: "albums" }); })}>Remove from crate</Button>}
          </div>
        </div>
      </header>
      <section className="section">
        <div className="section-title" style={{ justifyContent: "space-between" }}>
          <h2 className="display-md">Songs</h2>
          <span className="caption muted">Your ratings. Higher-rated songs come up more when you shuffle.</span>
        </div>
        <div>
          {tracks.map((t, i) => (
            <TrackRow key={t.id} index={i + 1} title={t.title} duration={formatTime(t.duration)} rating={p.ratings[t.id]} onRate={(v) => p.rate(t.id, v)}
              playing={p.current?.id === t.id} onPlay={() => p.playQueue(tracks, i)} actions={<AddToPlaylist trackIds={[t.id]} />} />
          ))}
        </div>
      </section>
    </div>
  );
}

/* ---------- Files on this computer ---------- */

function LocalFiles() {
  const p = usePlayer();
  return (
    <section className="section">
      <div className="section-title" style={{ justifyContent: "space-between" }}>
        <p className="muted">Play audio files from your computer. Ratings here stay on this computer.</p>
        <div style={{ display: "flex", gap: 12 }}>
          {p.localTracks.length > 1 && <Button onClick={() => p.shuffleAll(p.localTracks)}><Shuffle size={16} aria-hidden="true" /> Shuffle</Button>}
          <Button variant="primary" onClick={async () => p.addLocalTracks(await pickAudioFiles())}>Add audio files</Button>
        </div>
      </div>
      {p.localTracks.length ? (
        <div>
          {p.localTracks.map((t, i) => (
            <TrackRow key={t.id} index={i + 1} title={t.title} duration={t.duration ? formatTime(t.duration) : "—"} rating={p.ratings[t.id]}
              playing={p.current?.id === t.id} onPlay={() => p.playQueue(p.localTracks, i)} onRate={(v) => p.rate(t.id, v)}
              actions={<button type="button" className="mc-icon-btn" aria-label={`Remove ${t.title}`} onClick={() => p.removeLocalTrack(t.id)}><X size={16} aria-hidden="true" /></button>} />
          ))}
        </div>
      ) : (
        <div className="empty"><span>No files yet. MP3, FLAC, WAV, M4A and OGG all work.</span></div>
      )}
    </section>
  );
}
