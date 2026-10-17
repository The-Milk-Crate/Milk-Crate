import { useEffect, useRef, useState } from "react";
import { Ellipsis, ListPlus } from "lucide-react";
import { attempt, useLibrary } from "../lib/library";
import { usePlayer } from "../lib/player";
import { useCatalog } from "../lib/catalog";
import { downloadable, useDownloads } from "../lib/downloads";
import { SongInfoDialog, hasSongInfo } from "./SongInfo";
import type { Track } from "../lib/types";

/**
 * A song's (or an album's) menu: play next, add to the queue, add to one of
 * your playlists or a new one, and download for offline listening.
 */
export function AddToPlaylist({ trackIds, label, compact = true }: { trackIds: string[]; label?: string; compact?: boolean }) {
  const lib = useLibrary();
  const p = usePlayer();
  const c = useCatalog();
  const dl = useDownloads();
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState("");
  const [info, setInfo] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  const many = trackIds.length > 1;
  const name = label ?? (many ? "Album options" : "Song options");

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", esc); };
  }, [open]);

  const tracks = trackIds.map((id) => c.trackById[id] ?? p.localTracks.find((t) => t.id === id)).filter(Boolean) as Track[];
  const say = (text: string) => { setDone(text); setTimeout(() => setDone(""), 2000); };
  const after = (fn: () => void | Promise<void>, msg: string) => () => {
    setOpen(false);
    void attempt(async () => { await fn(); say(msg); }, (m) => say(m));
  };
  const canDownload = tracks.filter(downloadable);
  const allDownloaded = canDownload.length > 0 && canDownload.every((t) => dl.byTrack[t.id]);

  return (
    <span className="atp" ref={ref}>
      <button type="button" className={compact ? "mc-icon-btn" : "mc-btn"} aria-label={name} aria-haspopup="menu" aria-expanded={open}
        onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }} title={name}>
        {compact ? <Ellipsis size={18} strokeWidth={1.75} aria-hidden="true" /> : <ListPlus size={16} strokeWidth={1.75} aria-hidden="true" />}
        {!compact && name}
      </button>
      {done && <span className="atp-done caption" role="status">{done}</span>}
      {info && tracks[0] && <SongInfoDialog track={tracks[0]} artistName={c.artistById[tracks[0].artistId]?.name} onClose={() => setInfo(false)} />}
      {open && (
        <span className="atp-menu" role="menu" onClick={(e) => e.stopPropagation()}>
          <button type="button" role="menuitem" onClick={after(() => p.playNext(tracks), "Plays next")}>Play next</button>
          <button type="button" role="menuitem" onClick={after(() => p.addToQueue(tracks), "Added to the queue")}>Add to queue</button>
          {!many && tracks[0] && !tracks[0].id.startsWith("local:") && (lib.isSongInCrate(tracks[0].id, tracks[0].releaseId) ? (
            <button type="button" role="menuitem" onClick={after(() => lib.removeSongs([tracks[0].id], c.releaseById[tracks[0].releaseId]), "Taken out of your crate")}>Remove from your crate</button>
          ) : (
            <button type="button" role="menuitem" onClick={after(() => lib.addSongs([tracks[0].id]), "In your crate")}>Add to your crate</button>
          ))}
          {!many && hasSongInfo(tracks[0]) && <button type="button" role="menuitem" onClick={() => { setOpen(false); setInfo(true); }}>Lyrics and credits</button>}
          {canDownload.length > 0 && (
            allDownloaded
              ? <button type="button" role="menuitem" onClick={after(() => dl.remove(canDownload.map((t) => t.id)), "Download removed")}>Remove download</button>
              : <button type="button" role="menuitem" onClick={after(() => dl.download(canDownload), many ? "Downloaded" : "Downloaded")}>Download{many ? " all" : ""}</button>
          )}
          <span className="atp-label catalog" role="presentation">Add to playlist</span>
          {lib.signedIn ? (
            <>
              {lib.playlists.map((pl) => (
                <button key={pl.id} type="button" role="menuitem" onClick={after(() => lib.addToPlaylist(pl.id, trackIds), `Added to ${pl.name}`)}>{pl.name}</button>
              ))}
              <button type="button" role="menuitem" className="atp-new"
                onClick={after(async () => { await lib.createPlaylist(`New playlist ${lib.playlists.length + 1}`, trackIds); }, "Added to a new playlist")}>New playlist</button>
            </>
          ) : (
            <button type="button" role="menuitem" onClick={() => { setOpen(false); void attempt(() => lib.addToPlaylist("", [])); }}>Sign in to make playlists</button>
          )}
        </span>
      )}
    </span>
  );
}
