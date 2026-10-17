import { useMemo, useState, type ReactNode } from "react";
import { ChevronRight, Heart, Shuffle, Trash2, X } from "lucide-react";
import type { CrateTab, Go } from "../App";
import { useCatalog } from "../lib/catalog";
import { usePlayer } from "../lib/player";
import { FORMAT_LABEL, attempt, useLibrary } from "../lib/library";
import { usePersistentState } from "../lib/storage";
import { formatTime } from "../lib/format";
import { sleeveSeed } from "../lib/sleeve";
import { KIND_LABEL, buildCrate, byRecentlyPlayed, type CrateEntry } from "../lib/crate";
import { fileArtist, useFileCover } from "../lib/fileTags";
import type { Track } from "../lib/types";
import { Button, PlayButton, ReleaseCard, Sleeve, Sticker, TrackRow, useAllDownloaded, DownloadedMark } from "../components/ui";
import { AddToPlaylist } from "../components/AddToPlaylist";
import { AlbumRating } from "../components/AlbumRating";
import { HistoryList } from "../components/HistoryList";

/**
 * Your Crate. The overview has a shelf for each part: Albums, Singles,
 * Favorites, Recently Played and Playlists, each showing what you played last.
 * Click a shelf's heading for all of it. Your Computer and Your Shelf open
 * under Your Crate in the sidebar.
 */
export function Crate({ go, tab, releaseId, playlistId }: { go: Go; tab?: CrateTab; releaseId?: string; playlistId?: string }) {
  if (releaseId) return <CrateAlbum go={go} releaseId={releaseId} />;
  if (playlistId) return <CratePlaylist go={go} playlistId={playlistId} />;
  if (tab) return <CratePage go={go} tab={tab} />;
  return <CrateHome go={go} />;
}

/** Everything in your crate, one entry per release (albums, and singles/doubles/triples). */
export function useCrate(): CrateEntry[] {
  const c = useCatalog();
  const lib = useLibrary();
  const p = usePlayer();
  return useMemo(
    () => buildCrate(lib.saved, lib.crateSongs, c.releaseById, (id) => c.trackById[id]?.releaseId, p.history).sort(byRecentlyPlayed),
    [lib.saved, lib.crateSongs, c.releaseById, c.trackById, p.history],
  );
}

/** Your favorite songs: the ones you played most recently first, then the rest, newest favorite first. */
function useFavoriteTracks(): Track[] {
  const c = useCatalog();
  const lib = useLibrary();
  const p = usePlayer();
  return useMemo(() => {
    const local = p.localTracks.filter((t) => p.favorites.has(t.id));
    const all = [...lib.favorites.map((id) => c.trackById[id]).filter(Boolean), ...local];
    const played = new Map<string, number>();
    for (const h of p.history) if (!played.has(h.trackId)) played.set(h.trackId, h.at);
    return all.map((t, order) => ({ t, order })).sort((a, b) => (played.get(b.t.id) ?? 0) - (played.get(a.t.id) ?? 0) || a.order - b.order).map((x) => x.t);
  }, [lib.favorites, c.trackById, p.localTracks, p.favorites, p.history]);
}

/** Songs you've played, newest first, each once. */
function useRecentSongs(limit = 16): Track[] {
  const c = useCatalog();
  const p = usePlayer();
  return useMemo(() => {
    const local = new Map(p.localTracks.map((t) => [t.id, t]));
    const seen = new Set<string>();
    const out: Track[] = [];
    for (const h of p.history) {
      if (seen.has(h.trackId)) continue;
      seen.add(h.trackId);
      const t = c.trackById[h.trackId] ?? local.get(h.trackId);
      if (t) out.push(t);
      if (out.length >= limit) break;
    }
    return out;
  }, [p.history, c.trackById, p.localTracks, limit]);
}

const tracksOf = (e: CrateEntry, byId: Record<string, Track>) => e.trackIds.map((id) => byId[id]).filter(Boolean);
/** "album", "EP", "single". */
const kindWord = (k: string) => (k === "EP" ? k : k === "LP" ? "album" : k.toLowerCase());
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/* ---------- The overview: a shelf for each part of your crate ---------- */

function CrateHome({ go }: { go: Go }) {
  const c = useCatalog();
  const p = usePlayer();
  const lib = useLibrary();
  const crate = useCrate();
  const albums = crate.filter((e) => e.kind === "album");
  const singles = crate.filter((e) => e.kind !== "album");
  const favorites = useFavoriteTracks();
  const recent = useRecentSongs();
  const everything = useMemo(() => {
    const ids = new Set([...crate.flatMap((e) => e.trackIds), ...lib.favorites]);
    return [...ids].map((id) => c.trackById[id]).filter(Boolean);
  }, [crate, lib.favorites, c.trackById]);

  return (
    <div className="screen">
      <header className="screen-head">
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <span className="catalog eyebrow">{plural(albums.length, "album")} · {plural(singles.length, "single")} · {plural(favorites.length, "favorite")}</span>
          <h1 className="display-lg">Your Crate</h1>
        </div>
        <Button variant="primary" onClick={() => p.shuffleAll(everything)} disabled={!everything.length}>
          <Shuffle size={16} aria-hidden="true" /> Shuffle your crate
        </Button>
      </header>

      {!lib.signedIn && (
        <div className="empty">
          <span>Your crate lives in your account, so it's with you on any computer. Sign in or create a free listener account to add albums and songs, favorite songs and make playlists.</span>
          <Button size="sm" variant="primary" onClick={() => go({ name: "account" })}>Sign in</Button>
        </div>
      )}

      <CrateShelf title="Albums" count={albums.length} onOpen={() => go({ name: "crate", tab: "albums" })}
        empty="Open any album and choose Add to your crate. Four or more songs from one album land here too.">
        {albums.slice(0, 12).map((e) => <EntryTile key={e.release.id} entry={e} go={go} />)}
      </CrateShelf>

      <CrateShelf title="Singles" count={singles.length} onOpen={() => go({ name: "crate", tab: "singles" })}
        empty="Add one, two or three songs from an album (from a song's menu) and they show here as a single, double or triple.">
        {singles.slice(0, 12).map((e) => <EntryTile key={e.release.id} entry={e} go={go} />)}
      </CrateShelf>

      <CrateShelf title="Favorites" count={favorites.length} onOpen={() => go({ name: "crate", tab: "favorites" })}
        empty="Tap the heart next to any song and it lands here.">
        {favorites.slice(0, 12).map((t, i) => <SongTile key={t.id} track={t} onPlay={() => p.playQueue(favorites, i)} />)}
      </CrateShelf>

      <CrateShelf title="Recently Played" count={recent.length} showCount={false} onOpen={() => go({ name: "crate", tab: "history" })}
        empty="Songs you play show up here, even ones that aren't in your crate.">
        {recent.map((t) => <SongTile key={t.id} track={t} onPlay={() => p.playNow(t)} />)}
      </CrateShelf>

      <CrateShelf title="Playlists" count={lib.playlists.length} onOpen={() => go({ name: "crate", tab: "playlists" })}
        empty="Make a playlist here, or add songs to one from any song's menu.">
        {lib.playlists.slice(0, 12).map((pl) => {
          const first = pl.trackIds.map((id) => c.trackById[id]).find(Boolean);
          const r = first ? c.releaseById[first.releaseId] : undefined;
          return (
            <Tile key={pl.id} art={r?.art} seed={`playlist ${pl.name}`} title={pl.name} sub={plural(pl.trackIds.length, "song")}
              onOpen={() => go({ name: "crate", playlistId: pl.id })} />
          );
        })}
      </CrateShelf>
    </div>
  );
}

/** One shelf on the overview: a bordered heading (click for all of it) over a row of covers. */
function CrateShelf({ title, count, showCount = true, onOpen, empty, children }: {
  title: string; count: number; showCount?: boolean; onOpen: () => void; empty: string; children: ReactNode;
}) {
  return (
    <section className="crate-shelf" aria-label={title}>
      <button type="button" className="crate-heading" onClick={onOpen} aria-label={`${title}${showCount ? `, ${count}` : ""}. See all`}>
        <span className="display-md">{title}</span>
        {showCount && <span className="crate-heading-count numeral">{count}</span>}
        <ChevronRight size={20} strokeWidth={2} aria-hidden="true" />
      </button>
      {count ? <div className="cover-row">{children}</div> : <p className="caption muted crate-empty">{empty}</p>}
    </section>
  );
}

/** A square cover with a title under it. */
function Tile({ art, seed, title, sub, sticker, downloaded, onOpen, onPlay }: {
  art?: string; seed: string; title: string; sub?: string; sticker?: string; downloaded?: boolean; onOpen: () => void; onPlay?: () => void;
}) {
  return (
    <div className="cover-tile">
      <button type="button" className="cover-tile-open" onClick={onOpen} title={[title, sub].filter(Boolean).join(" · ")}>
        <span className="cover-tile-art">
          <Sleeve src={art} seed={seed} alt="" />
          {sticker && <Sticker>{sticker}</Sticker>}
        </span>
        <span className="cover-tile-title">{title}{downloaded && <> <DownloadedMark size={12} /></>}</span>
        {sub && <span className="cover-tile-sub caption muted">{sub}</span>}
      </button>
      {onPlay && (
        <button type="button" className="mc-play cover-tile-play" aria-label={`Play ${title}`} onClick={onPlay}>
          <svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor"><path d="M7 4.5v15a1 1 0 0 0 1.5.86l12.5-7.5a1 1 0 0 0 0-1.72L8.5 3.64A1 1 0 0 0 7 4.5Z" /></svg>
        </button>
      )}
    </div>
  );
}

function EntryTile({ entry: e, go }: { entry: CrateEntry; go: Go }) {
  const c = useCatalog();
  const p = usePlayer();
  const artist = c.artistById[e.release.artistId]?.name ?? "";
  const downloaded = useAllDownloaded(e.trackIds);
  const tracks = tracksOf(e, c.trackById);
  return (
    <Tile art={e.release.art} seed={sleeveSeed(e.release.title, artist)} title={e.release.title} sub={artist}
      sticker={e.kind === "album" ? undefined : KIND_LABEL[e.kind]} downloaded={downloaded}
      onOpen={() => go({ name: "crate", releaseId: e.release.id })} onPlay={tracks.length ? () => p.playQueue(tracks) : undefined} />
  );
}

function SongTile({ track: t, onPlay }: { track: Track; onPlay: () => void }) {
  const c = useCatalog();
  const r = c.releaseById[t.releaseId];
  const artist = c.artistById[t.artistId]?.name ?? (fileArtist(t) || "Your Computer");
  const fileCover = useFileCover(t.tags?.cover);
  return <Tile art={r?.art ?? fileCover} seed={r ? sleeveSeed(r.title, artist) : t.title} title={t.title} sub={artist} onOpen={onPlay} />;
}

/* ---------- A full page for one shelf ---------- */

const PAGE_TITLE: Record<CrateTab, string> = { albums: "Albums", singles: "Singles", favorites: "Favorites", history: "Recently Played", playlists: "Playlists" };

function CratePage({ go, tab }: { go: Go; tab: CrateTab }) {
  return (
    <div className="screen">
      <button type="button" className="link-btn caption" style={{ alignSelf: "flex-start" }} onClick={() => go({ name: "crate" })}>← Your Crate</button>
      <h1 className="display-lg">{PAGE_TITLE[tab]}</h1>
      {tab === "albums" && <Entries go={go} kind="albums" />}
      {tab === "singles" && <Entries go={go} kind="singles" />}
      {tab === "favorites" && <Favorites go={go} />}
      {tab === "history" && <History />}
      {tab === "playlists" && <PlaylistList go={go} />}
    </div>
  );
}

type EntrySort = "played" | "added" | "artist" | "title";
const ENTRY_SORTS: { id: EntrySort; label: string }[] = [
  { id: "played", label: "Recently played" },
  { id: "added", label: "Recently added" },
  { id: "artist", label: "Artist" },
  { id: "title", label: "Title" },
];

/** Every album, or every single/double/triple, in your crate. */
function Entries({ go, kind }: { go: Go; kind: "albums" | "singles" }) {
  const c = useCatalog();
  const p = usePlayer();
  const lib = useLibrary();
  const crate = useCrate();
  const [sort, setSort] = usePersistentState<EntrySort>(`mc.crateSort.${kind}`, "played");
  const byName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true });
  const artistOf = (e: CrateEntry) => c.artistById[e.release.artistId]?.name ?? "";
  const list = crate.filter((e) => (kind === "albums" ? e.kind === "album" : e.kind !== "album"));
  if (sort === "added") list.sort((a, b) => b.addedAt - a.addedAt);
  if (sort === "artist") list.sort((a, b) => byName(artistOf(a), artistOf(b)) || byName(a.release.title, b.release.title));
  if (sort === "title") list.sort((a, b) => byName(a.release.title, b.release.title));

  if (!list.length)
    return (
      <div className="empty">
        <span>{kind === "albums"
          ? "No albums yet. Open any album and choose Add to your crate. Four or more songs from one album count as an album too."
          : "No singles yet. From any song's menu choose Add to your crate. One, two or three songs from an album show here as a single, double or triple."}</span>
        <Button size="sm" onClick={() => go({ name: "home" })}>Find music</Button>
      </div>
    );

  return (
    <>
      <div className="section-title" style={{ justifyContent: "space-between" }}>
        <label className="field sort-field">
          <span className="catalog eyebrow">Sort by</span>
          <select value={sort} onChange={(e) => setSort(e.target.value as EntrySort)}>
            {ENTRY_SORTS.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
          </select>
        </label>
        <span className="caption muted">{plural(list.length, kind === "albums" ? "album" : "single")}</span>
      </div>
      <div className="release-grid">
        {list.map((e) => {
          const formats = lib.physical.filter((x) => x.releaseId === e.release.id).map((x) => (x.format === "7in" ? '7"' : x.format));
          const sticker = e.kind !== "album" ? KIND_LABEL[e.kind] : formats.length ? formats.join(" + ") : undefined;
          const tracks = tracksOf(e, c.trackById);
          return (
            <ReleaseCard key={e.release.id} title={e.release.title} artist={artistOf(e)} year={e.whole ? e.release.year : undefined} art={e.release.art}
              trackIds={e.trackIds} sticker={sticker} stickerTone="sticker"
              onOpen={() => go({ name: "crate", releaseId: e.release.id })} onPlay={tracks.length ? () => p.playQueue(tracks) : undefined} />
          );
        })}
      </div>
    </>
  );
}

/* ---------- Favorites: every song you've hearted ---------- */

function Favorites({ go }: { go: Go }) {
  const c = useCatalog();
  const p = usePlayer();
  const tracks = useFavoriteTracks();
  if (!tracks.length)
    return (
      <div className="empty">
        <span>No favorites yet. Tap the heart next to any song and it lands here. Favorites come up more when you shuffle.</span>
        <Button size="sm" onClick={() => go({ name: "home" })}>Find music</Button>
      </div>
    );
  return (
    <section className="section">
      <div className="section-title" style={{ justifyContent: "space-between" }}>
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <PlayButton playing={tracks.some((t) => t.id === p.current?.id) && p.playing} onClick={() => p.playQueue(tracks)} />
          <Button onClick={() => p.shuffleAll(tracks)}><Shuffle size={16} aria-hidden="true" /> Shuffle favorites</Button>
        </div>
        <span className="caption muted"><Heart size={12} aria-hidden="true" style={{ verticalAlign: "-1px" }} /> Played most recently first. Tap a heart again to take a song out.</span>
      </div>
      <div>
        {tracks.map((t, i) => {
          const album = c.releaseById[t.releaseId];
          return (
            <TrackRow key={t.id} trackId={t.id} index={i + 1} title={t.title} artist={[c.artistById[t.artistId]?.name ?? (fileArtist(t) || "Your Computer"), album?.title ?? t.tags?.album].filter(Boolean).join(" · ")}
              duration={t.duration ? formatTime(t.duration) : "—"} favorite={p.isFavorite(t.id)} onFavorite={() => p.toggleFavorite(t.id)}
              playing={p.current?.id === t.id} paused={!p.playing} onToggle={p.toggle} onPlay={() => p.playQueue(tracks, i)}
              actions={t.id.startsWith("local:") ? undefined : <AddToPlaylist trackIds={[t.id]} />} />
          );
        })}
      </div>
    </section>
  );
}

/* ---------- Listening history ---------- */

function History() {
  const p = usePlayer();
  const lib = useLibrary();
  const [sure, setSure] = useState(false);
  const [msg, setMsg] = useState("");
  return (
    <section className="section">
      <div className="section-title" style={{ justifyContent: "space-between" }}>
        <span className="caption muted" style={{ maxWidth: 520 }}>
          {lib.signedIn ? "Everything you've played, newest first. It's in your account, so it follows you to any computer, and only you can see it." : "Everything you've played on this computer, newest first. Sign in to keep it with you on any computer."}
        </span>
        {p.history.length > 0 && (sure ? (
          <span style={{ display: "flex", gap: 12, alignItems: "center" }}>
            <Button size="sm" onClick={() => void p.clearHistory().then(() => setMsg("History cleared.")).catch((e) => setMsg((e as Error).message)).finally(() => setSure(false))}>Clear it all</Button>
            <button type="button" className="link-btn caption" onClick={() => setSure(false)}>Keep it</button>
          </span>
        ) : (
          <Button size="sm" variant="ghost" onClick={() => setSure(true)}><Trash2 size={14} aria-hidden="true" /> Clear history</Button>
        ))}
      </div>
      {msg && <p className="form-info" role="status">{msg}</p>}
      <HistoryList />
    </section>
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
      <button type="button" className="link-btn caption" style={{ alignSelf: "flex-start" }} onClick={() => go({ name: "crate", tab: "playlists" })}>← Playlists</button>
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
            <TrackRow key={`${t.id}-${i}`} trackId={t.id} index={i + 1} title={t.title} artist={c.artistById[t.artistId]?.name} duration={formatTime(t.duration)}
              favorite={p.isFavorite(t.id)} onFavorite={() => p.toggleFavorite(t.id)} playing={p.current?.id === t.id} paused={!p.playing} onToggle={p.toggle}
              onPlay={() => p.playQueue(playable, playable.indexOf(t))}
              actions={<button type="button" className="mc-icon-btn" aria-label={`Remove ${t.title} from playlist`} onClick={() => void attempt(() => lib.removeFromPlaylist(pl.id, i))}><X size={16} aria-hidden="true" /></button>} />
          ) : null,
        )}
      </div>
    </div>
  );
}

/* ---------- One release in your crate: rate it, see which songs you have ---------- */

function CrateAlbum({ go, releaseId }: { go: Go; releaseId: string }) {
  const c = useCatalog();
  const p = usePlayer();
  const lib = useLibrary();
  const crate = useCrate();
  const [msg, setMsg] = useState("");
  const r = c.releaseById[releaseId];
  const entry = crate.find((e) => e.release.id === releaseId);
  const downloaded = useAllDownloaded(entry?.trackIds);
  if (!r) return <div className="screen"><p className="muted">Album not found.</p></div>;
  const a = c.artistById[r.artistId];
  const tracks = r.trackIds.map((id) => c.trackById[id]).filter(Boolean);
  const mine = new Set(entry?.trackIds ?? []);
  const inCrate = tracks.filter((t) => mine.has(t.id));
  const rest = tracks.filter((t) => !mine.has(t.id));
  const owned = lib.physical.filter((x) => x.releaseId === r.id);
  const back = entry && entry.kind !== "album" ? { tab: "singles" as const, label: "← Singles" } : { tab: "albums" as const, label: "← Albums" };
  const kindLabel = entry ? (entry.whole ? "In your crate" : `${KIND_LABEL[entry.kind]} in your crate · ${plural(inCrate.length, "song")} of ${tracks.length}`) : "Not in your crate";

  const row = (t: Track, i: number, list: Track[], dim: boolean) => (
    <div key={t.id} className={dim ? "crate-out" : undefined}>
      <TrackRow trackId={t.id} index={r.trackIds.indexOf(t.id) + 1} title={t.title} duration={formatTime(t.duration)} favorite={p.isFavorite(t.id)} onFavorite={() => p.toggleFavorite(t.id)}
        playing={p.current?.id === t.id} paused={!p.playing} onToggle={p.toggle} onPlay={() => p.playQueue(list, i)} actions={<AddToPlaylist trackIds={[t.id]} />} />
    </div>
  );

  return (
    <div className="screen">
      <button type="button" className="link-btn caption" style={{ alignSelf: "flex-start" }} onClick={() => go({ name: "crate", tab: back.tab })}>{back.label}</button>
      <header className="album-head">
        <Sleeve src={r.art} seed={sleeveSeed(r.title, a?.name ?? "")} alt={`${r.title} cover`} style={{ width: 200, flex: "none" }} />
        <div style={{ display: "flex", flexDirection: "column", gap: 10, flex: "1 1 320px", minWidth: 0 }}>
          <span className="catalog eyebrow">{kindLabel}{owned.length ? ` · on your shelf as ${owned.map((o) => FORMAT_LABEL[o.format]).join(", ")}` : ""}</span>
          <h1 className="display-lg">{r.title}</h1>
          <p className="muted">{a?.name} · {r.kind} · {r.year}{downloaded && <> · <DownloadedMark /> Downloaded</>}</p>
          <AlbumRating releaseId={r.id} />
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
            <PlayButton size="lg" playing={false} onClick={() => p.playQueue(inCrate.length ? inCrate : tracks)} />
            <Button onClick={() => go({ name: "album", releaseId: r.id })}>Album page</Button>
            {entry && !entry.whole && rest.length > 0 && (
              <Button onClick={() => void attempt(() => lib.save(r.id), setMsg)}>Add the whole {kindWord(r.kind)}</Button>
            )}
            {entry && (
              <Button variant="ghost" onClick={() => void attempt(async () => {
                if (entry.whole) await lib.unsave(r.id);
                else await lib.removeSongs(entry.trackIds);
                go({ name: "crate", tab: back.tab });
              }, setMsg)}><Trash2 size={14} aria-hidden="true" /> Remove from crate</Button>
            )}
          </div>
          {msg && <p className="form-info" role="status">{msg}</p>}
        </div>
      </header>
      <section className="section">
        <div className="section-title" style={{ justifyContent: "space-between" }}>
          <h2 className="display-md">{rest.length && inCrate.length ? "In your crate" : "Songs"}</h2>
          <span className="caption muted">Your album rating and hearted songs both steer what comes up when you shuffle.</span>
        </div>
        <div>{(inCrate.length ? inCrate : tracks).map((t, i, list) => row(t, i, list, false))}</div>
      </section>
      {inCrate.length > 0 && rest.length > 0 && (
        <section className="section">
          <div className="section-title" style={{ justifyContent: "space-between" }}>
            <h2 className="display-md">Also on this {kindWord(r.kind)}</h2>
            <span className="caption muted">Add one from its menu. Four or more songs and it moves to Albums.</span>
          </div>
          <div>{rest.map((t, i, list) => row(t, i, list, true))}</div>
        </section>
      )}
    </div>
  );
}
