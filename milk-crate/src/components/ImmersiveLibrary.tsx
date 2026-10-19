import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronLeft, Search } from "lucide-react";
import { usePlayer } from "../lib/player";
import { useCatalog } from "../lib/catalog";
import { useLibrary, type Playlist } from "../lib/library";
import { useRippedForCrate } from "../lib/ripped";
import { sleeveSeed } from "../lib/sleeve";
import { fileArtist } from "../lib/fileTags";
import type { Track } from "../lib/types";
import { useAlbumItems, useCrate } from "../screens/Crate";
import { HistoryCover } from "./HistoryList";
import { PlaylistCover, usePlaylistTracks } from "./PlaylistCover";
import { Button, Glyph } from "./ui";

/** One album in the mini library: from your crate, or a CD you ripped. */
interface LibAlbum { key: string; title: string; sub: string; art?: string; coverKey?: string; seed: string; tracks: Track[] }
type Tab = "albums" | "playlists" | "queue";
type View = { kind: "album"; key: string } | { kind: "playlist"; id: string } | null;

/** Your crate's albums (and ripped CDs), most recently played first, ready to show and play. */
function useLibAlbums(): LibAlbum[] {
  const c = useCatalog();
  const items = useAlbumItems(useCrate(), useRippedForCrate());
  return useMemo(() => items.map((x): LibAlbum => {
    if (x.cd) {
      const a = x.cd;
      return { key: `cd:${a.key}`, title: a.title, sub: [a.artist, a.year].filter(Boolean).join(" · "), coverKey: a.cover, seed: sleeveSeed(a.title, a.artist), tracks: a.tracks };
    }
    const r = x.crate.release;
    const artist = c.artistById[r.artistId]?.name ?? "";
    return {
      key: r.id, title: r.title, sub: [artist, r.year].filter(Boolean).join(" · "), art: r.art, seed: sleeveSeed(r.title, artist),
      tracks: x.crate.trackIds.map((id) => c.trackById[id]).filter(Boolean),
    };
  }), [items, c.artistById, c.trackById]);
}

/**
 * Immersive mode's mini library: a slim glass tab on the left edge that stays faintly visible, and,
 * when pressed, a glass panel with your crate's albums, your playlists and what's up next. Pick
 * something and it plays without leaving immersive mode.
 */
export function ImmersiveLibrary({ open, onOpen, onClose, onFullLibrary }: {
  open: boolean; onOpen: () => void; onClose: () => void; onFullLibrary: () => void;
}) {
  const albums = useLibAlbums();
  // Stays mounted a moment after closing so the panel can fade back into the edge.
  const [shown, setShown] = useState(open);
  useEffect(() => {
    if (open) { setShown(true); return; }
    const t = window.setTimeout(() => setShown(false), 260);
    return () => window.clearTimeout(t);
  }, [open]);
  const tab = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(open);
  useEffect(() => {
    if (wasOpen.current && !open) tab.current?.focus({ preventScroll: true });
    wasOpen.current = open;
  }, [open]);

  return (
    <>
      {!open && (
        <button ref={tab} type="button" className="imm-lib-tab" aria-label="Open your library" aria-expanded={false} onClick={onOpen}>
          <span className="imm-lib-grip" aria-hidden="true" />
          {albums.slice(0, 4).map((a) => (
            <span key={a.key} className="imm-lib-chip" aria-hidden="true"><HistoryCover art={a.art} coverKey={a.coverKey} seed={a.seed} size={40} /></span>
          ))}
          <span className="imm-lib-label" aria-hidden="true">Library</span>
        </button>
      )}
      {shown && <LibraryPanel albums={albums} closing={!open} onClose={onClose} onFullLibrary={onFullLibrary} />}
    </>
  );
}

function LibraryPanel({ albums, closing, onClose, onFullLibrary }: { albums: LibAlbum[]; closing: boolean; onClose: () => void; onFullLibrary: () => void }) {
  const p = usePlayer();
  const c = useCatalog();
  const lib = useLibrary();
  const [tab, setTab] = useState<Tab>("albums");
  const [view, setView] = useState<View>(null);
  const [q, setQ] = useState("");
  const search = useRef<HTMLInputElement>(null);
  const closeBtn = useRef<HTMLButtonElement>(null);
  useEffect(() => { (search.current ?? closeBtn.current)?.focus({ preventScroll: true }); }, []);

  const needle = q.trim().toLowerCase();
  const match = (...s: string[]) => !needle || s.join(" ").toLowerCase().includes(needle);
  const shownAlbums = albums.filter((a) => match(a.title, a.sub));
  const shownPlaylists = lib.playlists.filter((pl) => match(pl.name));
  const album = view?.kind === "album" ? albums.find((a) => a.key === view.key) : undefined;
  const playlist = view?.kind === "playlist" ? lib.playlists.find((pl) => pl.id === view.id) : undefined;
  const upNext = p.queue.map((t, i) => ({ t, i })).slice(p.index + 1);
  const artistOf = (t: Track) => c.artistById[t.artistId]?.name ?? (fileArtist(t) || "Your Computer");

  return (
    <aside className={`imm-lib${closing ? " is-closing" : ""}`} aria-label="Your library">
      <div className="imm-lib-head">
        <div className="imm-lib-title">
          <span className="imm-lib-mark" aria-hidden="true"><Glyph.crate /></span>
          <h2>Your Crate</h2>
        </div>
        <button ref={closeBtn} type="button" className="mc-icon-btn" aria-label="Close your library" onClick={onClose}><ChevronLeft size={20} strokeWidth={1.75} aria-hidden="true" /></button>
      </div>

      {view ? (
        <div className="imm-lib-tools">
          <Button size="sm" style={{ alignSelf: "flex-start" }} onClick={() => setView(null)}>
            <ChevronLeft size={16} strokeWidth={1.75} aria-hidden="true" /> {view.kind === "album" ? "Albums" : "Playlists"}
          </Button>
        </div>
      ) : (
        <div className="imm-lib-tools">
          {tab !== "queue" && (
            <label className="imm-lib-search">
              <Search size={16} strokeWidth={1.75} aria-hidden="true" />
              <span className="visually-hidden">Search your crate</span>
              <input ref={search} type="search" placeholder={tab === "albums" ? "Search your albums" : "Search your playlists"} value={q} onChange={(e) => setQ(e.target.value)} />
            </label>
          )}
          <div className="imm-lib-seg" role="group" aria-label="Show">
            <button type="button" aria-pressed={tab === "albums"} onClick={() => setTab("albums")}>Albums</button>
            <button type="button" aria-pressed={tab === "playlists"} onClick={() => setTab("playlists")}>Playlists</button>
            <button type="button" aria-pressed={tab === "queue"} onClick={() => setTab("queue")}>Up next</button>
          </div>
        </div>
      )}

      <div className="imm-lib-list">
        {album ? (
          <TrackList title={album.title} sub={album.sub} tracks={album.tracks}
            cover={<HistoryCover art={album.art} coverKey={album.coverKey} seed={album.seed} size={88} />} artistOf={artistOf} />
        ) : playlist ? (
          <PlaylistTracks playlist={playlist} artistOf={artistOf} />
        ) : tab === "albums" ? (
          shownAlbums.length ? shownAlbums.map((a) => {
            const on = !!p.current && a.tracks.some((t) => t.id === p.current!.id);
            return (
              <div key={a.key} className="imm-lib-item">
                <button type="button" className={`imm-lib-row${on ? " on" : ""}`} onClick={() => setView({ kind: "album", key: a.key })}>
                  <HistoryCover art={a.art} coverKey={a.coverKey} seed={a.seed} size={48} />
                  <span className="imm-lib-text"><span className="imm-lib-name">{a.title}</span><span className="caption muted">{a.sub}</span></span>
                </button>
                <button type="button" className="mc-icon-btn" aria-label={`Play ${a.title}`} disabled={!a.tracks.length} onClick={() => p.playQueue(a.tracks)}><Glyph.play /></button>
              </div>
            );
          }) : <p className="caption muted imm-lib-empty">{albums.length ? "No albums match that." : "Albums you add to your crate show up here."}</p>
        ) : tab === "playlists" ? (
          shownPlaylists.length ? shownPlaylists.map((pl) => <PlaylistRow key={pl.id} playlist={pl} onOpen={() => setView({ kind: "playlist", id: pl.id })} />)
            : <p className="caption muted imm-lib-empty">{lib.playlists.length ? "No playlists match that." : "Your playlists show up here."}</p>
        ) : (
          <>
            {p.current && (
              <>
                <span className="catalog eyebrow imm-lib-sub">Now playing</span>
                <div className="imm-lib-track on" aria-current="true">
                  <Glyph.play />
                  <span className="imm-lib-name">{p.current.title}</span>
                  <span className="caption">{artistOf(p.current)}</span>
                </div>
              </>
            )}
            <span className="catalog eyebrow imm-lib-sub">Up next</span>
            {upNext.length ? upNext.map(({ t, i }, n) => (
              <button key={`${i}-${t.id}`} type="button" className="imm-lib-track" onClick={() => p.jumpTo(i)}>
                <span className="numeral">{n + 1}</span>
                <span className="imm-lib-name">{t.title}</span>
                <span className="caption muted">{artistOf(t)}</span>
              </button>
            )) : <p className="caption muted imm-lib-empty">Nothing after this one. Pick an album or a playlist to keep going.</p>}
          </>
        )}
      </div>

      <div className="imm-lib-foot">
        <span className="caption muted">The music keeps playing while you look.</span>
        <Button size="sm" onClick={onFullLibrary}>Full library</Button>
      </div>
    </aside>
  );
}

function PlaylistRow({ playlist: pl, onOpen }: { playlist: Playlist; onOpen: () => void }) {
  const p = usePlayer();
  const tracks = usePlaylistTracks(pl.trackIds).filter(Boolean) as Track[];
  return (
    <div className="imm-lib-item">
      <button type="button" className="imm-lib-row" onClick={onOpen}>
        <PlaylistCover playlist={pl} style={{ width: 48, flex: "none" }} />
        <span className="imm-lib-text"><span className="imm-lib-name">{pl.name}</span><span className="caption muted">{tracks.length} {tracks.length === 1 ? "song" : "songs"}</span></span>
      </button>
      <button type="button" className="mc-icon-btn" aria-label={`Play ${pl.name}`} disabled={!tracks.length} onClick={() => p.playQueue(tracks)}><Glyph.play /></button>
    </div>
  );
}

function PlaylistTracks({ playlist: pl, artistOf }: { playlist: Playlist; artistOf: (t: Track) => string }) {
  const tracks = usePlaylistTracks(pl.trackIds).filter(Boolean) as Track[];
  return <TrackList title={pl.name} sub={`${tracks.length} ${tracks.length === 1 ? "song" : "songs"}`} tracks={tracks} showArtist
    cover={<PlaylistCover playlist={pl} style={{ width: 88, flex: "none" }} />} artistOf={artistOf} />;
}

/** An album's or a playlist's songs: play it all, put it next, or start from any song. */
function TrackList({ title, sub, tracks, cover, artistOf, showArtist = false }: {
  title: string; sub: string; tracks: Track[]; cover: ReactNode; artistOf: (t: Track) => string; showArtist?: boolean;
}) {
  const p = usePlayer();
  return (
    <>
      <div className="imm-lib-hero">
        {cover}
        <div className="imm-lib-hero-text">
          <span className="imm-lib-hero-title">{title}</span>
          <span className="caption muted">{sub}</span>
          <div className="imm-lib-hero-actions">
            <Button size="sm" variant="primary" disabled={!tracks.length} onClick={() => p.playQueue(tracks)}><Glyph.play /> Play</Button>
            <Button size="sm" disabled={!tracks.length} onClick={() => p.playNext(tracks)}>Play next</Button>
          </div>
        </div>
      </div>
      {tracks.map((t, i) => {
        const on = p.current?.id === t.id;
        return (
          <button key={`${i}-${t.id}`} type="button" className={`imm-lib-track${on ? " on" : ""}`} aria-current={on || undefined} onClick={() => p.playQueue(tracks, i)}>
            <span className="numeral">{on ? <Glyph.play /> : i + 1}</span>
            <span className="imm-lib-name">{t.title}</span>
            <span className="caption muted">{showArtist ? artistOf(t) : ""}</span>
          </button>
        );
      })}
    </>
  );
}
