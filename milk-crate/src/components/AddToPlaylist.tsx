import { useEffect, useRef, useState } from "react";
import { ListPlus } from "lucide-react";
import { attempt, useLibrary } from "../lib/library";

/** A small menu: add these songs to one of your playlists, or a new one. */
export function AddToPlaylist({ trackIds, label = "Add to playlist", compact = true }: { trackIds: string[]; label?: string; compact?: boolean }) {
  const lib = useLibrary();
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState("");
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  const add = (id: string, name: string) => {
    setOpen(false);
    void attempt(async () => { await lib.addToPlaylist(id, trackIds); setDone(`Added to ${name}`); setTimeout(() => setDone(""), 2000); });
  };
  const create = () => {
    setOpen(false);
    void attempt(async () => { const p = await lib.createPlaylist(`New playlist ${lib.playlists.length + 1}`, trackIds); setDone(`Added to ${p.name}`); setTimeout(() => setDone(""), 2000); });
  };

  return (
    <span className="atp" ref={ref}>
      <button type="button" className={compact ? "mc-icon-btn" : "mc-btn"} aria-label={label} aria-haspopup="menu" aria-expanded={open}
        onClick={(e) => { e.stopPropagation(); if (!lib.signedIn) void attempt(() => lib.addToPlaylist("", [])); else setOpen((o) => !o); }} title={label}>
        <ListPlus size={compact ? 18 : 16} strokeWidth={1.75} aria-hidden="true" />
        {!compact && label}
      </button>
      {done && <span className="atp-done caption" role="status">{done}</span>}
      {open && (
        <span className="atp-menu" role="menu">
          {lib.playlists.map((p) => (
            <button key={p.id} type="button" role="menuitem" onClick={() => add(p.id, p.name)}>{p.name}</button>
          ))}
          <button type="button" role="menuitem" className="atp-new" onClick={create}>New playlist</button>
        </span>
      )}
    </span>
  );
}
