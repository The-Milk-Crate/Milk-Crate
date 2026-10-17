import { useEffect, useMemo, useRef, useState } from "react";
import { FolderPlus, Lock, Shuffle, X } from "lucide-react";
import type { Go } from "../App";
import { usePlayer } from "../lib/player";
import { useLibrary } from "../lib/library";
import { pickAudioFiles } from "../lib/localFiles";
import { fileArtist, groupComputer, tagTrack, useFileCover, type ComputerAlbum } from "../lib/fileTags";
import { formatTime } from "../lib/format";
import type { Track } from "../lib/types";
import { Button, PlayButton, ReleaseCard, Sleeve, TrackRow } from "../components/ui";

/** Reads tags for several files, a few at a time. */
async function tagAll(tracks: Track[], onProgress: (done: number) => void): Promise<Track[]> {
  const out: Track[] = new Array(tracks.length);
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < tracks.length) {
      const i = next++;
      out[i] = await tagTrack(tracks[i]);
      onProgress(++done);
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  return out;
}

/**
 * Your Computer: albums and songs from audio files on this computer, sorted by
 * the tags inside the files. They play from where they are. Nothing is uploaded,
 * and each account on this computer has its own list, so only you see yours.
 */
export function Computer({ go, album }: { go: Go; album?: string }) {
  const p = usePlayer();
  const lib = useLibrary();
  const { albums, songs } = useMemo(() => groupComputer(p.localTracks), [p.localTracks]);
  const [work, setWork] = useState<{ done: number; total: number } | null>(null);
  const [msg, setMsg] = useState("");

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
      <button type="button" className="link-btn caption" style={{ alignSelf: "flex-start" }} onClick={() => go({ name: "computer" })}>← Your Computer</button>
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
          <Button variant="primary" onClick={() => void add()} disabled={!!work}><FolderPlus size={16} aria-hidden="true" /> Add audio files</Button>
        </div>
      </header>

      <p className="caption muted private-note">
        <Lock size={13} aria-hidden="true" />
        <span>
          These play straight from the files on this computer. Nothing is uploaded, and no one else can see them.
          {lib.signedIn ? " Each account on this computer has its own list." : " Sign in and they'll be kept with your account on this computer."}
        </span>
      </p>
      {work && <p className="form-info" role="status">Reading tags… {work.done} of {work.total}</p>}
      {msg && !work && <p className="form-info" role="status">{msg}</p>}

      {!p.localTracks.length && (
        <div className="empty">
          <span>No files yet. Add MP3, FLAC, WAV, M4A or OGG files and they're sorted into albums and songs by their tags (artist, album, track number and cover art).</span>
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
              <TrackRow key={t.id} index={i + 1} title={t.title} artist={[fileArtist(t), t.tags?.album].filter(Boolean).join(" · ") || undefined}
                duration={t.duration ? formatTime(t.duration) : "—"} favorite={p.isFavorite(t.id)} onFavorite={() => p.toggleFavorite(t.id)}
                playing={p.current?.id === t.id} paused={!p.playing} onToggle={p.toggle} onPlay={() => p.playQueue(songs, i)}
                actions={<button type="button" className="mc-icon-btn" aria-label={`Take ${t.title} off Your Computer`} title="Take it off this list (the file stays on your computer)" onClick={() => p.removeLocalTrack(t.id)}><X size={16} aria-hidden="true" /></button>} />
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

function ComputerAlbumView({ album: a, go }: { album: ComputerAlbum; go: Go }) {
  const p = usePlayer();
  const cover = useFileCover(a.cover);
  const [sure, setSure] = useState(false);
  const total = a.tracks.reduce((s, t) => s + (t.duration || 0), 0);
  return (
    <div className="screen">
      <button type="button" className="link-btn caption" style={{ alignSelf: "flex-start" }} onClick={() => go({ name: "computer" })}>← Your Computer</button>
      <header className="album-head">
        <Sleeve src={cover} seed={`${a.title}|${a.artist}`} alt={`${a.title} cover`} style={{ width: 200, flex: "none" }} />
        <div style={{ display: "flex", flexDirection: "column", gap: 10, flex: "1 1 320px", minWidth: 0 }}>
          <span className="catalog eyebrow">On your computer · only you can see it</span>
          <h1 className="display-lg">{a.title}</h1>
          <p className="muted">{[a.artist, a.year, `${a.tracks.length} songs`, total ? formatTime(total) : null].filter(Boolean).join(" · ")}</p>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
            <PlayButton size="lg" playing={a.tracks.some((t) => t.id === p.current?.id) && p.playing} onClick={() => p.playQueue(a.tracks)} />
            <Button onClick={() => p.shuffleAll(a.tracks)}><Shuffle size={16} aria-hidden="true" /> Shuffle</Button>
            {sure ? (
              <>
                <Button variant="ghost" onClick={() => { a.tracks.forEach((t) => p.removeLocalTrack(t.id)); go({ name: "computer" }); }}>Take it off the list</Button>
                <button type="button" className="link-btn caption" onClick={() => setSure(false)}>Keep it</button>
              </>
            ) : (
              <Button variant="ghost" onClick={() => setSure(true)}>Remove…</Button>
            )}
          </div>
          {sure && <p className="caption muted">The files stay on your computer. This only takes them off Your Computer in Milk Crate.</p>}
        </div>
      </header>
      <div>
        {a.tracks.map((t, i) => (
          <TrackRow key={t.id} index={t.tags?.trackNo ?? i + 1} title={t.title} artist={a.artist === "Various artists" ? fileArtist(t) : undefined}
            duration={t.duration ? formatTime(t.duration) : "—"} favorite={p.isFavorite(t.id)} onFavorite={() => p.toggleFavorite(t.id)}
            playing={p.current?.id === t.id} paused={!p.playing} onToggle={p.toggle} onPlay={() => p.playQueue(a.tracks, i)} />
        ))}
      </div>
    </div>
  );
}
