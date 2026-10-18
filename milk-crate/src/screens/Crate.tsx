import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Check, ChevronRight, Heart, ImagePlus, Plus, Shuffle, Trash2, X } from "lucide-react";
import type { CrateTab, Go } from "../App";
import { useCatalog } from "../lib/catalog";
import { usePlayer } from "../lib/player";
import { FORMAT_LABEL, attempt, useLibrary, type Playlist } from "../lib/library";
import { usePersistentState } from "../lib/storage";
import { formatTime } from "../lib/format";
import { sleeveSeed } from "../lib/sleeve";
import { KIND_LABEL, buildCrate, byRecentlyPlayed, type CrateEntry } from "../lib/crate";
import { fileArtist, useFileCover } from "../lib/fileTags";
import { useFileCovers, useRippedAlbums, type RippedAlbum } from "../lib/ripped";
import type { Track } from "../lib/types";
import { Button, PlayButton, ReleaseCard, Sleeve, Sticker, TrackRow, useAllDownloaded, DownloadedMark } from "../components/ui";
import { AddToPlaylist } from "../components/AddToPlaylist";
import { AlbumRating } from "../components/AlbumRating";
import { HistoryList } from "../components/HistoryList";
import { PlaylistCover, choosePlaylistCover, clearPlaylistCover, playlistCoverKey, usePlaylistTracks } from "../components/PlaylistCover";

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
  const favorites = useFavoriteTracks();
  const recent = useRecentSongs(RECENT_MAX);
  // CDs you ripped count as albums too (they play from this computer).
  const ripped = useRippedAlbums();
  const albums = useAlbumItems(crate, ripped);
  const songs = useCrateSongs();
  const everything = useMemo(() => {
    const ids = new Set([...crate.flatMap((e) => e.trackIds), ...lib.favorites]);
    return [...[...ids].map((id) => c.trackById[id]).filter(Boolean), ...ripped.flatMap((a) => a.tracks)];
  }, [crate, lib.favorites, c.trackById, ripped]);

  return (
    <div className="screen">
      <header className="screen-head">
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <span className="catalog eyebrow">{plural(albums.length, "album")} · {plural(songs.length, "song")} · {plural(favorites.length, "favorite")}</span>
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

      <CrateShelf title="Albums" count={albums.length} rows={2} onOpen={() => go({ name: "crate", tab: "albums" })}>
        {(n) => albums.slice(0, n).map((x) => x.cd
          ? <RippedTile key={`cd:${x.cd.key}`} album={x.cd} go={go} />
          : <EntryTile key={x.crate.release.id} entry={x.crate} go={go} />)}
      </CrateShelf>

      <CrateShelf title="Playlists" count={lib.playlists.length} onOpen={() => go({ name: "crate", tab: "playlists" })}>
        {(n) => lib.playlists.slice(0, n).map((pl) => (
          <Tile key={pl.id} seed={`playlist ${pl.name}`} cover={<PlaylistCover playlist={pl} />} title={pl.name} sub={plural(pl.trackIds.length, "song")}
            onOpen={() => go({ name: "crate", playlistId: pl.id })} />
        ))}
      </CrateShelf>

      <CrateShelf title="Recently Played" count={recent.length} showCount={false} onOpen={() => go({ name: "crate", tab: "history" })}>
        {(n) => recent.slice(0, n).map((t) => <SongTile key={t.id} track={t} onPlay={() => p.playNow(t)} />)}
      </CrateShelf>
    </div>
  );
}

/** Albums, EPs and singles in your crate plus the CDs you ripped: played most recently first. */
type AlbumItem = { crate: CrateEntry; cd?: undefined; at: number } | { cd: RippedAlbum; crate?: undefined; at: number };
function useAlbumItems(crate: CrateEntry[], ripped: RippedAlbum[]): AlbumItem[] {
  const p = usePlayer();
  return useMemo(() => {
    const played = new Map<string, number>();
    for (const h of p.history) if (!played.has(h.trackId)) played.set(h.trackId, h.at);
    const cdAt = (a: RippedAlbum) => Math.max(0, ...a.tracks.map((t) => played.get(t.id) ?? 0));
    const items: AlbumItem[] = [
      ...crate.map((e) => ({ crate: e, at: e.playedAt })),
      ...ripped.map((a) => ({ cd: a, at: cdAt(a) })),
    ];
    const added = (x: AlbumItem) => (x.crate ? x.crate.addedAt : x.cd!.rippedAt);
    return items.sort((a, b) => b.at - a.at || added(b) - added(a));
  }, [crate, ripped, p.history]);
}

/** Every song in your crate: from albums and singles you saved, your favorites, and CDs you ripped. Each once. */
function useCrateSongs(): Track[] {
  const c = useCatalog();
  const lib = useLibrary();
  const p = usePlayer();
  const crate = useCrate();
  const ripped = useRippedAlbums();
  return useMemo(() => {
    const seen = new Set<string>();
    const out: Track[] = [];
    const add = (t?: Track) => { if (t && !seen.has(t.id)) { seen.add(t.id); out.push(t); } };
    crate.forEach((e) => e.trackIds.forEach((id) => add(c.trackById[id])));
    lib.favorites.forEach((id) => add(c.trackById[id]));
    ripped.forEach((a) => a.tracks.forEach(add));
    p.localTracks.filter((t) => p.favorites.has(t.id)).forEach(add);
    return out;
  }, [crate, lib.favorites, c.trackById, ripped, p.localTracks, p.favorites]);
}

/** Recently Played on the overview: one row's worth (the rest are a click away). */
const RECENT_MAX = 24;
const TILE_W = 140;
const TILE_GAP = 16;

/**
 * One shelf on the overview: a bordered heading (click for all of it) over whole rows of covers.
 * As many covers per row as the window has room for; no sideways scrolling.
 */
function CrateShelf({ title, count, rows = 1, showCount = true, onOpen, children }: {
  title: string; count: number; rows?: number; showCount?: boolean; onOpen: () => void; children: (n: number) => ReactNode;
}) {
  const row = useRef<HTMLDivElement>(null);
  const [perRow, setPerRow] = useState(6);
  useLayoutEffect(() => {
    const el = row.current;
    if (!el) return;
    const measure = () => setPerRow(Math.max(1, Math.floor((el.clientWidth + TILE_GAP) / (TILE_W + TILE_GAP))));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [count > 0]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <section className="crate-shelf" aria-label={title}>
      <button type="button" className="crate-heading" onClick={onOpen} aria-label={`${title}${showCount ? `, ${count}` : ""}. See all`}>
        <span className="display-md">{title}</span>
        {showCount && <span className="crate-heading-count numeral">{count}</span>}
        <ChevronRight size={20} strokeWidth={2} aria-hidden="true" />
      </button>
      {count > 0 && (
        <div ref={row} className="cover-grid" style={{ gridTemplateColumns: `repeat(${perRow}, minmax(0, 1fr))` }}>{children(perRow * rows)}</div>
      )}
    </section>
  );
}

/** A square cover with a title under it. */
function Tile({ art, seed, cover, title, sub, sticker, downloaded, onOpen, onPlay }: {
  art?: string; seed: string; cover?: ReactNode; title: string; sub?: string; sticker?: string; downloaded?: boolean; onOpen: () => void; onPlay?: () => void;
}) {
  return (
    <div className="cover-tile">
      <button type="button" className="cover-tile-open" onClick={onOpen} title={[title, sub].filter(Boolean).join(" · ")}>
        <span className="cover-tile-art">
          {cover ?? <Sleeve src={art} seed={seed} alt="" />}
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

/** A CD you ripped (Your Computer album), in the Albums row. */
function RippedTile({ album: a, go }: { album: RippedAlbum; go: Go }) {
  const p = usePlayer();
  const cover = useFileCover(a.cover);
  return <Tile art={cover} seed={sleeveSeed(a.title, a.artist)} title={a.title} sub={a.artist} sticker="CD"
    onOpen={() => go({ name: "computer", album: a.key })} onPlay={() => p.playQueue(a.tracks)} />;
}

function SongTile({ track: t, onPlay }: { track: Track; onPlay: () => void }) {
  const c = useCatalog();
  const r = c.releaseById[t.releaseId];
  const artist = c.artistById[t.artistId]?.name ?? (fileArtist(t) || "Your Computer");
  const fileCover = useFileCover(t.tags?.cover);
  return <Tile art={r?.art ?? fileCover} seed={r ? sleeveSeed(r.title, artist) : t.title} title={t.title} sub={artist} onOpen={onPlay} />;
}

/* ---------- A full page for one shelf ---------- */

const PAGE_TITLE: Record<CrateTab, string> = { albums: "Albums", singles: "Albums", songs: "Songs", favorites: "Songs", history: "Recently Played", playlists: "Playlists" };

function CratePage({ go, tab }: { go: Go; tab: CrateTab }) {
  return (
    <div className="screen">
      <h1 className="display-lg">{PAGE_TITLE[tab]}</h1>
      {(tab === "albums" || tab === "singles") && <Entries go={go} />}
      {(tab === "songs" || tab === "favorites") && <Songs go={go} favoritesFirst={tab === "favorites"} />}
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

/** Every album, EP and single in your crate, and every CD you ripped. */
function Entries({ go }: { go: Go }) {
  const c = useCatalog();
  const p = usePlayer();
  const lib = useLibrary();
  const crate = useCrate();
  const [sort, setSort] = usePersistentState<EntrySort>("mc.crateSort.albums.v2", "artist");
  const byName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true });
  const artistOf = (e: CrateEntry) => c.artistById[e.release.artistId]?.name ?? "";
  const ripped = useRippedAlbums();
  const covers = useFileCovers(ripped.map((a) => a.cover));
  // Albums in your crate and CDs you ripped, sorted together.
  type Item = { crate: CrateEntry; cd?: undefined } | { cd: RippedAlbum; crate?: undefined };
  const list: Item[] = [
    ...crate.map((e) => ({ crate: e })),
    ...ripped.map((a) => ({ cd: a })),
  ];
  const titleOf = (x: Item) => (x.crate ? x.crate.release.title : x.cd!.title);
  const nameOf = (x: Item) => (x.crate ? artistOf(x.crate) : x.cd!.artist);
  const addedOf = (x: Item) => (x.crate ? x.crate.addedAt : x.cd!.rippedAt);
  if (sort === "added") list.sort((a, b) => addedOf(b) - addedOf(a));
  if (sort === "artist") list.sort((a, b) => byName(nameOf(a), nameOf(b)) || byName(titleOf(a), titleOf(b)));
  if (sort === "title") list.sort((a, b) => byName(titleOf(a), titleOf(b)));

  if (!list.length)
    return (
      <div className="empty">
        <span>No albums yet. Open any album and choose Add to your crate. Songs you add on their own show here too, as a single, double or triple.</span>
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
        <span className="caption muted">{plural(list.length, "album")}</span>
      </div>
      <div className="release-grid">
        {list.map((x) => {
          if (x.cd) {
            const a = x.cd;
            return (
              <ReleaseCard key={`cd:${a.key}`} title={a.title} artist={a.artist} year={a.year} art={a.cover ? covers[a.cover] : undefined}
                seed={sleeveSeed(a.title, a.artist)} sticker="CD" stickerTone="sticker"
                onOpen={() => go({ name: "computer", album: a.key })} onPlay={() => p.playQueue(a.tracks)} />
            );
          }
          const e = x.crate;
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

/* ---------- Songs: every song in your crate, in one list ---------- */

type SongSort = "played" | "title" | "artist" | "album";
const SONG_SORTS: { id: SongSort; label: string }[] = [
  { id: "played", label: "Recently played" },
  { id: "title", label: "Title" },
  { id: "artist", label: "Artist" },
  { id: "album", label: "Album" },
];

function Songs({ go, favoritesFirst }: { go: Go; favoritesFirst: boolean }) {
  const c = useCatalog();
  const p = usePlayer();
  const all = useCrateSongs();
  const favs = useFavoriteTracks();
  const [only, setOnly] = useState(favoritesFirst);
  const [sort, setSort] = usePersistentState<SongSort>("mc.crateSort.songs.v2", "artist");
  const artistOf = (t: Track) => c.artistById[t.artistId]?.name ?? (fileArtist(t) || "Your Computer");
  const albumOf = (t: Track) => c.releaseById[t.releaseId]?.title ?? t.tags?.album ?? "";
  const tracks = useMemo(() => {
    const list = only ? [...favs] : [...all];
    const byName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true });
    const played = new Map<string, number>();
    for (const h of p.history) if (!played.has(h.trackId)) played.set(h.trackId, h.at);
    if (sort === "played") list.sort((a, b) => (played.get(b.id) ?? 0) - (played.get(a.id) ?? 0));
    if (sort === "title") list.sort((a, b) => byName(a.title, b.title));
    if (sort === "artist") list.sort((a, b) => byName(artistOf(a), artistOf(b)) || byName(albumOf(a), albumOf(b)) || (a.tags?.trackNo ?? 0) - (b.tags?.trackNo ?? 0));
    if (sort === "album") list.sort((a, b) => byName(albumOf(a), albumOf(b)) || (a.tags?.trackNo ?? 0) - (b.tags?.trackNo ?? 0));
    return list;
  }, [only, favs, all, sort, p.history, c]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <section className="section">
      <div className="section-title" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
        <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <PlayButton playing={tracks.some((t) => t.id === p.current?.id) && p.playing} onClick={() => tracks.length && p.playQueue(tracks)} />
          <Button onClick={() => p.shuffleAll(tracks)} disabled={!tracks.length}><Shuffle size={16} aria-hidden="true" /> Shuffle</Button>
          <div role="group" aria-label="Show" style={{ display: "flex", gap: 6 }}>
            <button type="button" className="chip" aria-pressed={!only} onClick={() => setOnly(false)}>All songs</button>
            <button type="button" className="chip" aria-pressed={only} onClick={() => setOnly(true)}>
              <Heart size={12} aria-hidden="true" style={{ verticalAlign: "-1px" }} /> Favorites
            </button>
          </div>
        </div>
        <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
          <label className="field sort-field">
            <span className="catalog eyebrow">Sort by</span>
            <select value={sort} onChange={(e) => setSort(e.target.value as SongSort)}>
              {SONG_SORTS.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
            </select>
          </label>
          <span className="caption muted">{plural(tracks.length, "song")}</span>
        </div>
      </div>
      {!tracks.length ? (
        <div className="empty">
          <span>{only
            ? "No favorites yet. Tap the heart next to any song and it lands here. Favorites come up more when you shuffle."
            : "No songs yet. Add albums or songs to your crate, favorite songs, or rip a CD, and they all show here."}</span>
          <Button size="sm" onClick={() => go({ name: "home" })}>Find music</Button>
        </div>
      ) : (
        <div>
          {tracks.map((t, i) => (
            <TrackRow key={t.id} trackId={t.id} index={i + 1} title={t.title} artist={[artistOf(t), albumOf(t)].filter(Boolean).join(" · ")}
              duration={t.duration ? formatTime(t.duration) : "—"} favorite={p.isFavorite(t.id)} onFavorite={() => p.toggleFavorite(t.id)}
              playing={p.current?.id === t.id} paused={!p.playing} onToggle={p.toggle} onPlay={() => p.playQueue(tracks, i)}
              actions={<AddToPlaylist trackIds={[t.id]} />} />
          ))}
        </div>
      )}
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
  const lib = useLibrary();
  const [name, setName] = useState("");

  const create = () => void attempt(async () => {
    const pl = await lib.createPlaylist(name.trim() || `New playlist ${lib.playlists.length + 1}`);
    setName("");
    go({ name: "crate", playlistId: pl.id });
  });

  return (
    <div className="playlist-list" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <form className="panel" style={{ flexDirection: "row", alignItems: "flex-end", flexWrap: "wrap" }} onSubmit={(e) => { e.preventDefault(); create(); }}>
        <label className="field" style={{ flex: "1 1 260px" }}>
          <span className="catalog eyebrow">New playlist</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name it" maxLength={100} />
        </label>
        <Button variant="primary" type="submit">Create</Button>
      </form>
      {lib.playlists.length === 0 && lib.signedIn && <p className="muted">No playlists yet. Add songs to one from any album with the playlist button.</p>}
      {lib.playlists.map((pl) => <PlaylistRow key={pl.id} pl={pl} go={go} />)}
    </div>
  );
}

function PlaylistRow({ pl, go }: { pl: Playlist; go: Go }) {
  const p = usePlayer();
  const tracks = usePlaylistTracks(pl.trackIds).filter(Boolean) as Track[];
  return (
          <div className="list-row">
            <PlaylistCover playlist={pl} style={{ width: 48, flex: "none" }} />
            <PlayButton playing={false} onClick={() => p.playQueue(tracks)} />
            <button type="button" className="link-btn" style={{ flex: "1 1 auto", textAlign: "left", textDecoration: "none", color: "var(--ink)", fontWeight: 650 }}
              onClick={() => go({ name: "crate", playlistId: pl.id })}>{pl.name}</button>
            <span className="caption muted">{tracks.length} {tracks.length === 1 ? "song" : "songs"} · {formatTime(tracks.reduce((s, t) => s + (t.duration || 0), 0))}</span>
          </div>
  );
}

function CratePlaylist({ go, playlistId }: { go: Go; playlistId: string }) {
  const lib = useLibrary();
  const pl = lib.playlists.find((x) => x.id === playlistId);
  if (!pl) return <div className="screen"><p className="muted">Playlist not found.</p><Button onClick={() => go({ name: "crate", tab: "playlists" })}>Back to playlists</Button></div>;
  return <PlaylistPage go={go} pl={pl} key={pl.id} />;
}

function PlaylistPage({ go, pl }: { go: Go; pl: Playlist }) {
  const c = useCatalog();
  const p = usePlayer();
  const lib = useLibrary();
  const [name, setName] = useState(pl.name);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [coverMsg, setCoverMsg] = useState("");
  const [coverMenu, setCoverMenu] = useState(false);
  const pick = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!coverMenu) return;
    const close = (e: Event) => { if (!pick.current?.contains(e.target as Node)) setCoverMenu(false); };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setCoverMenu(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", esc); };
  }, [coverMenu]);
  const own = useFileCover(playlistCoverKey(pl.id));
  const tracks = usePlaylistTracks(pl.trackIds);
  const playable = tracks.filter(Boolean) as Track[];
  const artistOf = (t: Track) => c.artistById[t.artistId]?.name ?? (fileArtist(t) || "Your Computer");

  return (
    <div className="screen">
      <header className="album-head">
        <div style={{ display: "flex", flexDirection: "column", gap: 8, alignItems: "flex-start", flex: "none" }}>
          {/* Click the cover to pick a picture (or, with one picked, change or remove it: then Milk Crate makes one). */}
          <div ref={pick} className="playlist-cover-pick">
            <button type="button" className="playlist-cover-btn" aria-haspopup={own ? "menu" : undefined} aria-expanded={own ? coverMenu : undefined}
              aria-label={own ? "Change or remove the playlist's picture" : "Choose a picture for the playlist"} title={own ? "Change or remove the picture" : "Choose a picture"}
              onClick={() => { setCoverMsg(""); if (own) setCoverMenu((o) => !o); else void choosePlaylistCover(pl.id).then((e) => setCoverMsg(e ?? "")); }}>
              <PlaylistCover playlist={pl} style={{ width: 200 }} />
              <span className="playlist-cover-hint" aria-hidden="true"><ImagePlus size={22} /></span>
            </button>
            {own && coverMenu && (
              <span className="atp-menu playlist-cover-menu" role="menu">
                <button type="button" role="menuitem" onClick={() => { setCoverMenu(false); void choosePlaylistCover(pl.id).then((e) => setCoverMsg(e ?? "")); }}>Change picture</button>
                <button type="button" role="menuitem" onClick={() => { setCoverMenu(false); void clearPlaylistCover(pl.id); }}>Remove picture</button>
              </span>
            )}
          </div>
          {coverMsg && <span className="form-error caption" role="alert">{coverMsg}</span>}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10, flex: "1 1 320px", minWidth: 0 }}>
          <span className="catalog eyebrow">Playlist · {plural(playable.length, "song")} · {formatTime(playable.reduce((s, t) => s + (t.duration || 0), 0))} · only you can see it</span>
          <input className="title-input display-lg" value={name} aria-label="Playlist name" maxLength={100}
            onChange={(e) => setName(e.target.value)} onBlur={() => name.trim() !== pl.name && void attempt(() => lib.renamePlaylist(pl.id, name))}
            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} />
          {pl.localCount > 0 && (
            <p className="caption muted">{plural(pl.localCount, "song")} from your computer {pl.localCount === 1 ? "is" : "are"} in here. They stay on this computer and play only here.</p>
          )}
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
            <PlayButton size="lg" playing={false} onClick={() => p.playQueue(playable)} />
            <Button onClick={() => p.shuffleAll(playable)} disabled={!playable.length}><Shuffle size={16} aria-hidden="true" /> Shuffle</Button>
            {confirmDelete ? (
              <Button variant="ghost" onClick={() => void attempt(async () => { await lib.deletePlaylist(pl.id); void clearPlaylistCover(pl.id); go({ name: "crate", tab: "playlists" }); })}>Delete for good</Button>
            ) : (
              <Button variant="ghost" onClick={() => setConfirmDelete(true)}>Delete playlist</Button>
            )}
          </div>
        </div>
      </header>
      <AddSongs pl={pl} />
      {tracks.length === 0 && <p className="muted">Empty for now. Use the ⋯ menu next to any song, including songs from CDs you ripped.</p>}
      <div>
        {tracks.map((t, i) =>
          t ? (
            <TrackRow key={`${t.id}-${i}`} trackId={t.id} index={i + 1} title={t.title}
              artist={[artistOf(t), c.releaseById[t.releaseId]?.title ?? t.tags?.album].filter(Boolean).join(" · ")}
              duration={t.duration ? formatTime(t.duration) : "—"}
              favorite={p.isFavorite(t.id)} onFavorite={() => p.toggleFavorite(t.id)} playing={p.current?.id === t.id} paused={!p.playing} onToggle={p.toggle}
              onPlay={() => p.playQueue(playable, playable.indexOf(t))}
              actions={<button type="button" className="mc-icon-btn" aria-label={`Remove ${t.title} from playlist`} onClick={() => void attempt(() => lib.removeFromPlaylist(pl.id, i))}><X size={16} aria-hidden="true" /></button>} />
          ) : null,
        )}
      </div>
    </div>
  );
}

/**
 * Add songs to a playlist from its page: search Milk Crate and your computer's songs (ripped CDs
 * included) by title, artist or album; with nothing typed, songs from your crate.
 */
function AddSongs({ pl }: { pl: Playlist }) {
  const c = useCatalog();
  const p = usePlayer();
  const lib = useLibrary();
  const crateSongs = useCrateSongs();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [added, setAdded] = useState<Record<string, true>>({});
  const artistOf = (t: Track) => c.artistById[t.artistId]?.name ?? (fileArtist(t) || "Your Computer");
  const albumOf = (t: Track) => c.releaseById[t.releaseId]?.title ?? t.tags?.album ?? "";
  const results = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return crateSongs.slice(0, 30);
    const seen = new Set<string>();
    const all = [...c.tracks.filter((t) => t.src), ...p.localTracks].filter((t) => (seen.has(t.id) ? false : (seen.add(t.id), true)));
    return all.filter((t) => {
      const hay = `${t.title} ${artistOf(t)} ${albumOf(t)}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    }).slice(0, 40);
  }, [q, crateSongs, c.tracks, p.localTracks]); // eslint-disable-line react-hooks/exhaustive-deps
  const inList = new Set(pl.trackIds);
  const add = (t: Track) => void attempt(async () => { await lib.addToPlaylist(pl.id, [t.id]); setAdded((a) => ({ ...a, [t.id]: true })); });

  if (!open) return <div><Button onClick={() => setOpen(true)}><Plus size={16} aria-hidden="true" /> Add songs</Button></div>;
  return (
    <section className="panel add-songs" aria-label="Add songs">
      <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
        <label className="field" style={{ flex: 1 }}>
          <span className="catalog eyebrow">Add songs</span>
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Song, artist or album" />
        </label>
        <Button variant="ghost" onClick={() => { setOpen(false); setQ(""); }}>Done</Button>
      </div>
      {!q && results.length > 0 && <span className="caption muted">From your crate</span>}
      {results.length === 0 && <p className="caption muted">{q ? "Nothing matches that." : "Nothing in your crate yet. Search for any song on Milk Crate or your computer."}</p>}
      <div className="add-songs-list">
        {results.map((t) => {
          const has = added[t.id] || inList.has(t.id);
          return (
            <div key={t.id} className="add-songs-row">
              <span style={{ display: "flex", flexDirection: "column", minWidth: 0, flex: 1 }}>
                <span className="add-songs-title">{t.title}</span>
                <span className="caption muted add-songs-sub">{[artistOf(t), albumOf(t)].filter(Boolean).join(" · ")}</span>
              </span>
              <Button size="sm" variant={has ? "ghost" : undefined} onClick={() => add(t)} aria-label={`Add ${t.title}${has ? " again" : ""}`}>
                {has ? <><Check size={14} aria-hidden="true" /> Added</> : <><Plus size={14} aria-hidden="true" /> Add</>}
              </Button>
            </div>
          );
        })}
      </div>
    </section>
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
  const back = { tab: "albums" as const };
  const kindLabel = entry ? (entry.whole ? "In your crate" : `${KIND_LABEL[entry.kind]} in your crate · ${plural(inCrate.length, "song")} of ${tracks.length}`) : "Not in your crate";

  const row = (t: Track, i: number, list: Track[], dim: boolean) => (
    <div key={t.id} className={dim ? "crate-out" : undefined}>
      <TrackRow trackId={t.id} index={r.trackIds.indexOf(t.id) + 1} title={t.title} duration={formatTime(t.duration)} favorite={p.isFavorite(t.id)} onFavorite={() => p.toggleFavorite(t.id)}
        playing={p.current?.id === t.id} paused={!p.playing} onToggle={p.toggle} onPlay={() => p.playQueue(list, i)} actions={<AddToPlaylist trackIds={[t.id]} />} />
    </div>
  );

  return (
    <div className="screen">
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
