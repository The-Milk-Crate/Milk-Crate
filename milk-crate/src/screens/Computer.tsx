import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeftRight, Disc3, FolderPlus, ImagePlus, PencilLine, Shuffle, X } from "lucide-react";
import type { Go } from "../App";
import type { Track } from "../lib/types";
import { usePlayer } from "../lib/player";
import { isDesktop, pickAudioFiles } from "../lib/localFiles";
import { canRip } from "../lib/cd";
import { CdRipper } from "../components/CdRipper";
import { ComputerLink } from "../components/ComputerLink";
import { useRip } from "../lib/ripSession";
import { AddToPlaylist } from "../components/AddToPlaylist";
import { changeRippedCover, setCopyPref, useEditRipped, useRippedAlbums } from "../lib/ripped";
import { fileArtist, groupComputer, tagAll, useFileCover, type ComputerAlbum } from "../lib/fileTags";
import { useAddRipped } from "../lib/ripped";
import { formatTime } from "../lib/format";
import { Button, PlayButton, ReleaseCard, Sleeve, TrackRow } from "../components/ui";

/** Reads tags for several files, a few at a time. */

/**
 * Your Computer: albums and songs from audio files on this computer, sorted by
 * the tags inside the files. They play from where they are. Nothing is uploaded,
 * and each account on this computer has its own list, so only you see yours.
 */
export function Computer({ go, album }: { go: Go; album?: string }) {
  const p = usePlayer();
  const { albums, songs } = useMemo(() => groupComputer(p.localTracks), [p.localTracks]);
  const [work, setWork] = useState<{ done: number; total: number } | null>(null);
  const [msg, setMsg] = useState("");
  // Open stays open while you browse elsewhere, so a rip in progress is here when you come back.
  const [ripOpen, setRipOpen] = useRip("open");

  // A ripped CD: its new files join Your Computer, tags (names, cover) read from the files.
  const addRipped = useAddRipped();
  const [linkOpen, setLinkOpen] = useState(false);

  // Files added before tags were read: read them once.
  const tried = useRef(new Set<string>());
  useEffect(() => {
    const untagged = p.localTracks.filter((t) => !t.tags && !tried.current.has(t.id));
    if (!untagged.length || work) return;
    untagged.forEach((t) => tried.current.add(t.id));
    setWork({ done: 0, total: untagged.length });
    void tagAll(untagged, (done) => setWork({ done, total: untagged.length }))
      .then((tagged) => p.updateLocalTracks(tagged))
      .finally(() => setWork(null));
  }, [p.localTracks]); // eslint-disable-line react-hooks/exhaustive-deps

  const add = async () => {
    setMsg("");
    const picked = await pickAudioFiles();
    const fresh = picked.filter((t) => !p.localTracks.some((x) => x.id === t.id));
    if (!fresh.length) { if (picked.length) setMsg("Those files are already here."); return; }
    fresh.forEach((t) => tried.current.add(t.id));
    setWork({ done: 0, total: fresh.length });
    const tagged = await tagAll(fresh, (done) => setWork({ done, total: fresh.length }));
    p.addLocalTracks(tagged);
    setWork(null);
    const grouped = groupComputer(tagged);
    setMsg(`Added ${fresh.length} ${fresh.length === 1 ? "file" : "files"}${grouped.albums.length ? ` (${grouped.albums.length} ${grouped.albums.length === 1 ? "album" : "albums"})` : ""}.`);
  };

  const open = album ? albums.find((a) => a.key === album) : undefined;
  if (album) return open ? <ComputerAlbumView go={go} album={open} /> : (
    <div className="screen">
      <p className="muted">That album isn't here anymore.</p>
    </div>
  );

  return (
    <div className="screen">
      <header className="screen-head">
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <span className="catalog eyebrow">{albums.length} {albums.length === 1 ? "album" : "albums"} · {songs.length} {songs.length === 1 ? "song" : "songs"} · on this computer</span>
          <h1 className="display-lg">Your Computer</h1>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
          {p.localTracks.length > 1 && <Button onClick={() => p.shuffleAll(p.localTracks)}><Shuffle size={16} aria-hidden="true" /> Shuffle</Button>}
          {canRip() && <Button onClick={() => setRipOpen(true)} disabled={ripOpen}><Disc3 size={16} aria-hidden="true" /> Rip a CD</Button>}
          {isDesktop() && <Button onClick={() => setLinkOpen(true)} disabled={linkOpen}><ArrowLeftRight size={16} aria-hidden="true" /> Send to another computer</Button>}
          <Button variant="primary" onClick={() => void add()} disabled={!!work}><FolderPlus size={16} aria-hidden="true" /> Add audio files</Button>
        </div>
      </header>

      {ripOpen && <CdRipper onClose={() => setRipOpen(false)} onRipped={addRipped} />}
      {linkOpen && <ComputerLink onClose={() => setLinkOpen(false)} />}
      {work && <p className="form-info" role="status">Reading tags… {work.done} of {work.total}</p>}
      {msg && !work && <p className="form-info" role="status">{msg}</p>}

      {!p.localTracks.length && (
        <div className="empty">
          <span>No files yet. Add MP3, FLAC, WAV, M4A or OGG files and they're sorted into albums and songs by their tags (artist, album, track number and cover art).{canRip() ? " Or rip a CD: it's saved as FLAC with the names and cover filled in." : ""}</span>
        </div>
      )}

      {albums.length > 0 && (
        <section className="section">
          <h2 className="display-md">Albums</h2>
          <div className="release-grid">
            {albums.map((a) => <ComputerAlbumCard key={a.key} album={a} go={go} />)}
          </div>
        </section>
      )}

      {songs.length > 0 && (
        <section className="section">
          <h2 className="display-md">Songs</h2>
          <div>
            {songs.map((t, i) => (
              <TrackRow key={t.id} trackId={t.id} index={i + 1} title={t.title} artist={[fileArtist(t), t.tags?.album].filter(Boolean).join(" · ") || undefined}
                duration={t.duration ? formatTime(t.duration) : "—"} favorite={p.isFavorite(t.id)} onFavorite={() => p.toggleFavorite(t.id)}
                playing={p.current?.id === t.id} paused={!p.playing} onToggle={p.toggle} onPlay={() => p.playQueue(songs, i)}
                actions={<>
                  <AddToPlaylist trackIds={[t.id]} />
                  <button type="button" className="mc-icon-btn" aria-label={`Take ${t.title} off Your Computer`} title="Take it off this list (the file stays on your computer)" onClick={() => p.removeLocalTrack(t.id)}><X size={16} aria-hidden="true" /></button>
                </>} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function ComputerAlbumCard({ album: a, go }: { album: ComputerAlbum; go: Go }) {
  const p = usePlayer();
  const cover = useFileCover(a.cover);
  return (
    <ReleaseCard title={a.title} artist={a.artist} year={a.year} art={cover} seed={`${a.title}|${a.artist}`}
      onOpen={() => go({ name: "computer", album: a.key })} onPlay={() => p.playQueue(a.tracks)} />
  );
}

/** An album's songs by disc ("Disc 1", "Disc 2"…), keeping each song's place in the whole album. One disc: one group, no label. */
function discGroups(tracks: Track[]): { disc: number; label?: string; items: { t: Track; i: number }[] }[] {
  const groups = new Map<number, { t: Track; i: number }[]>();
  tracks.forEach((t, i) => {
    const d = t.tags?.discNo ?? 1;
    if (!groups.has(d)) groups.set(d, []);
    groups.get(d)!.push({ t, i });
  });
  const many = groups.size > 1;
  return [...groups.entries()].sort(([x], [y]) => x - y).map(([disc, items]) => ({ disc, label: many ? `Disc ${disc}` : undefined, items }));
}

function ComputerAlbumView({ album: a, go }: { album: ComputerAlbum; go: Go }) {
  const p = usePlayer();
  const cover = useFileCover(a.cover);
  const [sure, setSure] = useState(false);
  const total = a.tracks.reduce((s, t) => s + (t.duration || 0), 0);
  // A CD you ripped can get a different cover.
  const ripped = p.rippedCds.some((r) => r.key === a.key);
  // The same album ripped from both a CD and a record: pick which copy plays.
  const me = useRippedAlbums().find((r) => r.key === a.key);
  const copies = me && me.copies.length > 1 ? [...me.copies].sort((x, y) => (x.format === "Vinyl" ? 0 : 1) - (y.format === "Vinyl" ? 0 : 1)) : [];
  const [coverMsg, setCoverMsg] = useState("");
  const newCover = async () => { setCoverMsg(""); setCoverMsg((await changeRippedCover(a, p.updateLocalTracks)) ?? ""); };
  // A CD you ripped: its album title, year and song titles can be changed.
  const editRipped = useEditRipped();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ album: a.title, year: a.year ? String(a.year) : "", titles: {} as Record<string, string> });
  const [saving, setSaving] = useState(false);
  const [editMsg, setEditMsg] = useState("");
  const startEdit = () => {
    setDraft({ album: a.title, year: a.year ? String(a.year) : "", titles: Object.fromEntries(a.tracks.map((t) => [t.id, t.title])) });
    setEditMsg("");
    setEditing(true);
  };
  const save = async () => {
    setSaving(true);
    setEditMsg("");
    try {
      const key = await editRipped(a, draft);
      setEditing(false);
      if (key !== a.key) go({ name: "computer", album: key });
    } catch (e) {
      setEditMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };
  if (editing) {
    return (
      <div className="screen">
        <form className="album-head" onSubmit={(e) => { e.preventDefault(); void save(); }}>
          <Sleeve src={cover} seed={`${a.title}|${a.artist}`} alt={`${a.title} cover`} style={{ width: 200, flex: "none" }} />
          <div style={{ display: "flex", flexDirection: "column", gap: 12, flex: "1 1 320px", minWidth: 0 }}>
            <span className="catalog eyebrow">Editing · saved into the CD's files on this computer</span>
            <label className="field">
              <span className="catalog eyebrow">Album title</span>
              <input value={draft.album} maxLength={300} onChange={(e) => setDraft((d) => ({ ...d, album: e.target.value }))} autoFocus />
            </label>
            <label className="field" style={{ maxWidth: 160 }}>
              <span className="catalog eyebrow">Year</span>
              <input value={draft.year} inputMode="numeric" maxLength={4} placeholder="e.g. 1995"
                onChange={(e) => setDraft((d) => ({ ...d, year: e.target.value.replace(/\D/g, "") }))} />
            </label>
            {editMsg && <p className="form-error" role="alert">{editMsg}</p>}
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
              <Button variant="primary" type="submit" disabled={saving}>{saving ? "Saving…" : "Save"}</Button>
              <Button variant="ghost" onClick={() => setEditing(false)} disabled={saving}>Cancel</Button>
            </div>
          </div>
        </form>
        {discGroups(a.tracks).map((g) => (
          <section key={g.disc} className="disc-group">
            {g.label && <h2 className="catalog eyebrow disc-heading">{g.label}</h2>}
            <ol className="edit-songs" aria-label={g.label ? `${g.label} song titles` : "Song titles"}>
              {g.items.map(({ t, i }) => (
                <li key={t.id}>
                  <span className="numeral muted" aria-hidden="true">{t.tags?.trackNo ?? i + 1}</span>
                  <input aria-label={`Title of ${g.label ? `${g.label.toLowerCase()}, ` : ""}song ${t.tags?.trackNo ?? i + 1}`} value={draft.titles[t.id] ?? t.title} maxLength={300}
                    onChange={(e) => setDraft((d) => ({ ...d, titles: { ...d.titles, [t.id]: e.target.value } }))}
                    onKeyDown={(e) => e.key === "Enter" && void save()} />
                </li>
              ))}
            </ol>
          </section>
        ))}
      </div>
    );
  }
  return (
    <div className="screen">
      <header className="album-head">
        <Sleeve src={cover} seed={`${a.title}|${a.artist}`} alt={`${a.title} cover`} style={{ width: 200, flex: "none" }} />
        <div style={{ display: "flex", flexDirection: "column", gap: 10, flex: "1 1 320px", minWidth: 0 }}>
          <span className="catalog eyebrow">{me ? `Ripped from ${me.format === "Vinyl" ? "vinyl" : "CD"}` : "On your computer"} · only you can see it</span>
          <h1 className="display-lg">{a.title}</h1>
          {copies.length > 1 && me && (
            <div className="copy-switch" role="group" aria-label="Play from">
              <span className="catalog eyebrow">Play from</span>
              {copies.map((c) => (
                <button key={c.key} type="button" className="chip" aria-pressed={c.key === a.key}
                  onClick={() => { setCopyPref(c.copyKey, c.format); if (c.key !== a.key) go({ name: "computer", album: c.key }); }}>
                  {c.format === "Vinyl" ? "Vinyl" : "CD"}
                </button>
              ))}
            </div>
          )}
          <p className="muted">{[a.artist, a.year, `${a.tracks.length} songs`, total ? formatTime(total) : null].filter(Boolean).join(" · ")}</p>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
            <PlayButton size="lg" playing={a.tracks.some((t) => t.id === p.current?.id) && p.playing} onClick={() => p.playQueue(a.tracks)} />
            <Button onClick={() => p.shuffleAll(a.tracks)}><Shuffle size={16} aria-hidden="true" /> Shuffle</Button>
            {sure ? (
              <>
                <Button variant="ghost" onClick={() => { a.tracks.forEach((t) => p.removeLocalTrack(t.id)); go({ name: "computer" }); }}>Take it off the list</Button>
                <Button onClick={() => setSure(false)}>Keep it</Button>
              </>
            ) : (
              <Button variant="ghost" onClick={() => setSure(true)}>Remove…</Button>
            )}
            {ripped && (
              <>
                <Button variant="ghost" onClick={startEdit}><PencilLine size={16} aria-hidden="true" /> Edit info</Button>
                <Button variant="ghost" onClick={() => void newCover()}><ImagePlus size={16} aria-hidden="true" /> Change cover</Button>
              </>
            )}
          </div>
          {coverMsg && <p className="form-error" role="alert">{coverMsg}</p>}
          {sure && <p className="caption muted">The files stay on your computer. This only takes them off Your Computer in Milk Crate.</p>}
        </div>
      </header>
      <div>
        {discGroups(a.tracks).map((g) => (
          <section key={g.disc} className="disc-group" aria-label={g.label}>
            {g.label && <h2 className="catalog eyebrow disc-heading">{g.label}</h2>}
            {g.items.map(({ t, i }) => (
              <TrackRow key={t.id} trackId={t.id} index={t.tags?.trackNo ?? i + 1} title={t.title} artist={a.artist === "Various artists" ? fileArtist(t) : undefined}
                duration={t.duration ? formatTime(t.duration) : "—"} favorite={p.isFavorite(t.id)} onFavorite={() => p.toggleFavorite(t.id)}
                playing={p.current?.id === t.id} paused={!p.playing} onToggle={p.toggle} onPlay={() => p.playQueue(a.tracks, i)}
                actions={<AddToPlaylist trackIds={[t.id]} />} />
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}
