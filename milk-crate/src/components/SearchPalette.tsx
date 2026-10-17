import { useEffect, useMemo, useRef, useState } from "react";
import { Search, X } from "lucide-react";
import type { Go } from "../App";
import { useCatalog } from "../lib/catalog";
import { usePlayer } from "../lib/player";
import { useArtistPlaces, useLocation } from "../lib/location";
import { placeKey, placeLabelFrom, regionAndCountry, type Country } from "../lib/geo";
import { sleeveSeed } from "../lib/sleeve";
import { Sleeve } from "./ui";
import { ArtistThumb } from "./ArtistBanner";
import { routeFromLink } from "../lib/share";

type Result =
  | { kind: "artist"; id: string; title: string; sub: string; score: number }
  | { kind: "album"; id: string; title: string; sub: string; score: number }
  | { kind: "song"; id: string; title: string; sub: string; score: number }
  | { kind: "town"; id: string; title: string; sub: string; score: number; name: string; state: string; country: Country };

const GROUPS: { kind: Result["kind"]; label: string }[] = [
  { kind: "artist", label: "Artists" },
  { kind: "album", label: "Albums" },
  { kind: "song", label: "Songs" },
  { kind: "town", label: "Towns" },
];
const PER_GROUP = 5;

/** Opens search from anywhere (the app shell listens for this). */
export const openSearch = (text = "") => window.dispatchEvent(new CustomEvent("mc:search", { detail: text }));

/** How well `text` matches the query: starts with it, a word starts with it, or contains it. 0 = no match. */
function score(text: string, q: string) {
  const t = text.toLowerCase();
  if (t === q) return 4;
  if (t.startsWith(q)) return 3;
  if (t.split(/[\s\-–,.&/]+/).some((w) => w.startsWith(q))) return 2;
  return t.includes(q) ? 1 : 0;
}

/**
 * Search everything: artists, albums, songs and towns. Opens with Ctrl+K (⌘K
 * on Mac) or "/" from anywhere. Arrow keys move, Enter opens, Esc closes.
 */
export function SearchPalette({ go, initial = "", onClose }: { go: Go; initial?: string; onClose: () => void }) {
  const c = useCatalog();
  const p = usePlayer();
  const placed = useArtistPlaces();
  const loc = useLocation();
  const [query, setQuery] = useState(initial);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const q = query.trim().toLowerCase();
  // A pasted share link opens what it points to.
  const linked = useMemo(() => routeFromLink(query), [query]);

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    input.current?.focus();
    return () => prev?.focus?.();
  }, []);

  const results = useMemo<Result[]>(() => {
    if (!q || linked) return [];
    const out: Result[] = [];
    for (const a of c.artists) {
      const s = Math.max(score(a.name, q) * 2, ...a.genres.map((g) => score(g, q)), score(a.place, q));
      if (s) out.push({ kind: "artist", id: a.id, title: a.name, sub: [a.place, a.genres.slice(0, 2).join(", ")].filter(Boolean).join(" · "), score: s });
    }
    for (const r of c.releases) {
      const a = c.artistById[r.artistId];
      const s = Math.max(score(r.title, q) * 2, a ? score(a.name, q) : 0);
      if (s) out.push({ kind: "album", id: r.id, title: r.title, sub: [a?.name, r.kind, r.year].filter(Boolean).join(" · "), score: s });
    }
    for (const t of c.tracks) {
      const s = score(t.title, q) * 2;
      if (s) out.push({ kind: "song", id: t.id, title: t.title, sub: [c.artistById[t.artistId]?.name, c.releaseById[t.releaseId]?.title].filter(Boolean).join(" · "), score: s });
    }
    const mine = loc.home?.country;
    const towns = new Map<string, { name: string; state: string; country: Country; n: number }>();
    for (const a of placed) {
      const k = placeKey(a.place);
      towns.set(k, { name: a.place.name, state: a.place.state, country: a.place.country, n: (towns.get(k)?.n ?? 0) + 1 });
    }
    for (const [k, t] of towns) {
      const s = score(t.name, q) * 2;
      if (s) out.push({ kind: "town", id: k, title: placeLabelFrom(t, mine), sub: `${t.n} ${t.n === 1 ? "artist" : "artists"}`, score: s + 1, name: t.name, state: t.state, country: t.country });
    }
    // Any other town, to look around (no bands there yet).
    if (q.length >= 3 && loc.places) {
      let extra = 0;
      for (const pl of loc.places) {
        if (extra >= 3 || towns.has(placeKey(pl))) continue;
        if (pl.name.toLowerCase().startsWith(q)) {
          out.push({ kind: "town", id: placeKey(pl), title: placeLabelFrom(pl, mine), sub: `No bands yet · ${regionAndCountry(pl)}`, score: 1, name: pl.name, state: pl.state, country: pl.country });
          extra++;
        }
      }
    }
    // Best first within each group, a few per group, groups in a fixed order.
    return GROUPS.flatMap((g) => out.filter((r) => r.kind === g.kind).sort((a, b) => b.score - a.score || a.title.localeCompare(b.title)).slice(0, PER_GROUP));
  }, [q, linked, c.artists, c.releases, c.tracks, c.artistById, c.releaseById, placed, loc.places, loc.home?.country]);

  useEffect(() => setActive(0), [q]);
  useEffect(() => {
    list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const open = (r: Result) => {
    onClose();
    if (r.kind === "artist") go({ name: "artist", artistId: r.id });
    else if (r.kind === "album") go({ name: "album", releaseId: r.id });
    else if (r.kind === "town") go({ name: "scenes", explore: { name: r.name, state: r.state, country: r.country } });
    else {
      const t = c.trackById[r.id];
      const album = c.releaseById[t.releaseId];
      const tracks = album ? album.trackIds.map((id) => c.trackById[id]).filter(Boolean) : [t];
      p.playQueue(tracks, Math.max(0, tracks.findIndex((x) => x.id === t.id)));
      if (album) go({ name: "album", releaseId: album.id });
    }
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((i) => Math.min(results.length - 1, i + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((i) => Math.max(0, i - 1)); }
    else if (e.key === "Enter" && linked) { e.preventDefault(); onClose(); go(linked); }
    else if (e.key === "Enter" && results[active]) { e.preventDefault(); open(results[active]); }
    else if (e.key === "Escape") { e.preventDefault(); onClose(); }
  };

  const icon = (r: Result) => {
    if (r.kind === "artist") { const a = c.artistById[r.id]; return a ? <ArtistThumb artist={a} size={36} /> : null; }
    if (r.kind === "album" || r.kind === "song") {
      const rel = r.kind === "album" ? c.releaseById[r.id] : c.releaseById[c.trackById[r.id]?.releaseId];
      return <Sleeve src={rel?.art} seed={rel ? sleeveSeed(rel.title, c.artistById[rel.artistId]?.name ?? "") : r.title} style={{ width: 36, flex: "none" }} />;
    }
    return <span className="search-town-dot" aria-hidden="true" />;
  };

  let shownGroup = "";
  return (
    <div className="modal-backdrop search-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="search-palette" role="dialog" aria-modal="true" aria-label="Search Milk Crate">
        <div className="search-input-row">
          <Search size={18} strokeWidth={1.75} aria-hidden="true" />
          <input ref={input} type="search" role="combobox" aria-expanded={results.length > 0} aria-controls="search-results" aria-autocomplete="list"
            aria-activedescendant={results[active] ? `search-opt-${active}` : undefined} placeholder="Artists, albums, songs, towns"
            value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={onKey} />
          <button type="button" className="mc-icon-btn" aria-label="Close search" onClick={onClose}><X size={18} strokeWidth={1.75} aria-hidden="true" /></button>
        </div>
        <div ref={list} id="search-results" role="listbox" aria-label="Results" className="search-results">
          {results.map((r, i) => {
            const label = GROUPS.find((g) => g.kind === r.kind)!.label;
            const header = label !== shownGroup ? (shownGroup = label) : null;
            return (
              <div key={`${r.kind}-${r.id}`} role="presentation">
                {header && <div className="catalog eyebrow search-group" role="presentation">{header}</div>}
                <div id={`search-opt-${i}`} data-index={i} role="option" aria-selected={i === active} className={`search-opt${i === active ? " active" : ""}`}
                  onMouseMove={() => setActive(i)} onClick={() => open(r)}>
                  {icon(r)}
                  <span style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
                    <span className="search-title">{r.title}</span>
                    <span className="caption muted search-sub">{r.kind === "song" ? `Song · ${r.sub}` : r.sub}</span>
                  </span>
                </div>
              </div>
            );
          })}
          {linked && (
            <div role="option" aria-selected="true" id="search-opt-0" className="search-opt active" onClick={() => { onClose(); go(linked); }}>
              <span className="search-town-dot" aria-hidden="true" />
              <span style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
                <span className="search-title">Open this link</span>
                <span className="caption muted search-sub">{linked.name === "album" ? "An album" : linked.name === "artist" ? "An artist" : "A scene"} on Milk Crate · Enter to open</span>
              </span>
            </div>
          )}
          {q && !linked && !results.length && <p className="muted" style={{ padding: "12px 16px" }}>Nothing matches "{query.trim()}".</p>}
          {!q && <p className="caption muted" style={{ padding: "12px 16px" }}>Type to search. ↑ ↓ to move, Enter to open, Esc to close.</p>}
        </div>
      </div>
    </div>
  );
}
