import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { ChevronLeft, ChevronRight, ImagePlus, Plus, Trash2, Volume2, VolumeX } from "lucide-react";
import type { Go, ShelfFormat } from "../App";
import { useCatalog } from "../lib/catalog";
import { usePlayer } from "../lib/player";
import { FORMAT_LABEL, attempt, useLibrary, type PhysicalItem } from "../lib/library";
import { sleeveSeed } from "../lib/sleeve";
import { usePersistentState } from "../lib/storage";
import { SHELF_SECTIONS, flipSound, ownedSections, setShelfSounds, shelfSoundsOn, sortShelf, spineColor, useFlipper, type ShelfSort } from "../lib/shelf";
import type { PhysicalFormat, Release, Track } from "../lib/types";
import { Button, PlayButton, Sleeve } from "../components/ui";
import { changeRippedCover, useFileCovers, useRippedAlbums, type RippedAlbum } from "../lib/ripped";

/** One thing on your shelf, with what's needed to draw and play it. */
interface ShelfItem {
  item: PhysicalItem;
  release?: Release;
  title: string;
  artist: string;
  year?: number;
  art?: string;
  seed: string;
  /** Paper and label color, for things with no cover. */
  color: string;
  tracks: Track[];
  /** A CD you ripped: its album in Your Computer (local only, never shared). */
  ripped?: RippedAlbum;
}

function useShelfItems(format?: PhysicalFormat): ShelfItem[] {
  const c = useCatalog();
  const lib = useLibrary();
  const ripped = useRippedAlbums();
  const covers = useFileCovers(ripped.map((a) => a.cover));
  const owned = useMemo(() => lib.physical.filter((x) => !format || x.format === format).map((item) => {
    const release = item.releaseId ? c.releaseById[item.releaseId] : undefined;
    const a = release ? c.artistById[release.artistId] : undefined;
    const title = release?.title ?? item.title;
    const artist = a?.name ?? item.artistName;
    const seed = sleeveSeed(title, artist);
    return {
      item, release, title, artist, year: release?.year, art: release?.art, seed,
      color: a?.accent ?? spineColor(seed),
      tracks: (release?.trackIds ?? []).map((id) => c.trackById[id]).filter(Boolean),
    };
  }), [lib.physical, format, c.releaseById, c.artistById, c.trackById]);
  const cds = useMemo(() => (format && format !== "CD" ? [] : ripped.map((a): ShelfItem => {
    const seed = sleeveSeed(a.title, a.artist);
    return {
      item: { id: `ripped:${a.key}`, format: "CD", artistName: a.artist, title: a.title, note: "", addedAt: new Date(a.rippedAt).toISOString() },
      title: a.title, artist: a.artist, year: a.year, art: a.cover ? covers[a.cover] : undefined, seed, color: spineColor(seed), tracks: a.tracks, ripped: a,
    };
  })), [ripped, covers, format]);
  return useMemo(() => [...owned, ...cds], [owned, cds]);
}

/**
 * Your Shelf: your records, 45s, CDs and tapes. Each section is a flat stack:
 * the one you're on shows big in the middle, the rest tuck behind it on both
 * sides with a strip of each showing. Sort A–Z or by year. Sections only show
 * when you have something in them.
 */
export function Shelf({ go, format }: { go: Go; format?: ShelfFormat }) {
  const all = useShelfItems();
  const sections = ownedSections(all.map((x) => x.item.format));
  const current = sections.find((s) => s.id === format) ?? sections[0];
  const [adding, setAdding] = useState(false);
  const [sounds, setSounds] = useState(shelfSoundsOn);
  const counts = sections.map((s) => {
    const n = all.filter((x) => x.item.format === s.format).length;
    return `${n} ${n === 1 ? s.one : `${s.one}s`}`;
  });

  return (
    <div className="screen shelf-screen">
      <header className="screen-head">
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <span className="catalog eyebrow">{counts.length ? counts.join(" · ") : "Records, 45s, CDs and tapes you own"}</span>
          <h1 className="display-lg">Your Shelf</h1>
        </div>
        <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          {sections.length > 0 && (
            <button type="button" className="mc-icon-btn" aria-pressed={sounds} onClick={() => { setShelfSounds(!sounds); setSounds(!sounds); }}
              title={sounds ? "Flip sounds on" : "Flip sounds off"} aria-label="Flip sounds">
              {sounds ? <Volume2 size={18} aria-hidden="true" /> : <VolumeX size={18} aria-hidden="true" />}
            </button>
          )}
          <Button variant={adding || !sections.length ? "ghost" : "primary"} onClick={() => setAdding((a) => !a)} aria-expanded={adding}>
            <Plus size={16} aria-hidden="true" /> Add to your shelf
          </Button>
        </div>
      </header>

      {(adding || !sections.length) && (
        <AddToShelf defaultFormat={current?.format} onAdded={(f) => { setAdding(false); go({ name: "shelf", format: SHELF_SECTIONS.find((s) => s.format === f)!.id }); }}
          intro={!sections.length} />
      )}

      {current && <ShelfSection key={current.id} current={current} sections={sections} go={go} />}
    </div>
  );
}

/** One section (vinyl, 45s, CDs or tapes): its tabs, its sort (remembered for each section) and its stack. */
function ShelfSection({ current, sections, go }: { current: (typeof SHELF_SECTIONS)[number]; sections: (typeof SHELF_SECTIONS)[number][]; go: Go }) {
  const [sort, setSort] = usePersistentState<ShelfSort>(`mc.shelfSort.${current.id}`, "az");
  const raw = useShelfItems(current.format);
  const items = useMemo(() => sortShelf(raw, sort), [raw, sort]);
  return (
    <>
      <div className="shelf-bar">
        <div role="tablist" aria-label="Your shelf" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {sections.map((s) => (
            <button key={s.id} type="button" role="tab" className="chip" aria-selected={s.id === current.id} aria-pressed={s.id === current.id}
              onClick={() => go({ name: "shelf", format: s.id })}>
              {s.label}
            </button>
          ))}
        </div>
        <div role="group" aria-label="Sort" className="shelf-sort">
          <span className="catalog eyebrow">Sort</span>
          <button type="button" className="chip" aria-pressed={sort === "az"} onClick={() => setSort("az")}>A–Z</button>
          <button type="button" className="chip" aria-pressed={sort === "year"} onClick={() => setSort("year")}>Year</button>
        </div>
      </div>
      <section className="shelf-section" aria-label={current.label}>
        <FlatStack key={sort} items={items} kind={current.id} go={go} />
      </section>
    </>
  );
}

/* ---------- The flat stack ---------- */

/** Each format's size (the small ones; the one you're on is shown 1.3× bigger) and how much of each neighbor shows. */
const SIZES: Record<ShelfFormat, { w: number; h: number; strip: number; one: string }> = {
  vinyl: { w: 260, h: 260, strip: 44, one: "record" },
  "45s": { w: 190, h: 190, strip: 40, one: "45" },
  cds: { w: 232, h: 206, strip: 40, one: "CD" },
  cassettes: { w: 256, h: 164, strip: 44, one: "tape" },
};
const GROW = 1.3;
/** How many on each side are drawn (the rest are hidden behind them anyway). */
const SHOWN = 10;

/**
 * How much bigger than the base sizes the stack is drawn: it grows to fill the space it has
 * (wide and tall windows get big records), never smaller than the base and at most 1.75×.
 */
function useStackScale(kind: ShelfFormat) {
  const box = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const base = SIZES[kind];
    const fit = () => {
      // Room for the one you're on (grown) and strips of two neighbors each side; the rest tuck out of view.
      const byWidth = el.clientWidth / (base.w * GROW + base.strip * 4);
      // Leave room above for the page header and tabs, below for the controls and the player.
      const byHeight = (window.innerHeight - 420) / (base.h * GROW + 40);
      setScale(Math.max(1, Math.min(1.75, byWidth, byHeight)));
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    window.addEventListener("resize", fit);
    return () => { ro.disconnect(); window.removeEventListener("resize", fit); };
  }, [kind]);
  return { box, scale };
}

function FlatStack({ items, kind, go }: { items: ShelfItem[]; kind: ShelfFormat; go: Go }) {
  const { box, scale } = useStackScale(kind);
  const base = SIZES[kind];
  const size = { ...base, w: Math.round(base.w * scale), h: Math.round(base.h * scale), strip: Math.round(base.strip * scale) };
  const { index, setIndex, wasDrag, handlers } = useFlipper(items.length, {
    axis: "x", step: size.strip,
    onFlip: () => flipSound(kind === "cds" ? "case" : kind === "cassettes" ? "tape" : "sleeve"),
  });
  // Arrow keys flip anywhere on the page (not while typing; Alt+arrows go back and forward).
  const flip = useRef(setIndex);
  flip.current = setIndex;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      if ((e.target as HTMLElement)?.closest?.("input, textarea, select, [contenteditable='true'], [role='dialog']")) return;
      const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -1, ArrowDown: 1 }[e.key];
      if (!step || (e.key.startsWith("ArrowU") || e.key.startsWith("ArrowD")) && !(e.target as HTMLElement)?.closest?.(".flat-stage")) return;
      e.preventDefault();
      flip.current((i) => i + step);
    };
    // Capture, so the shelf gets the arrows before the app-wide arrow-key scrolling (src/lib/scrollbars.ts).
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
  const front = items[index];
  if (!front) return null;
  const big = (size.w * GROW - size.w) / 2;
  const stageH = Math.round(size.h * GROW) + 40;

  return (
    <div className="flat-dig">
      <div ref={box} style={{ display: "flex", flexDirection: "column", gap: 16, minWidth: 0 }}>
        <div className="flat-stage" tabIndex={0} role="group" aria-roledescription="stack"
          aria-label={`${items.length} ${size.one}s. Scroll, drag or use the arrow keys to flip.`}
          style={{ height: stageH }} onWheel={handlers.onWheel} onPointerDown={handlers.onPointerDown} onPointerMove={handlers.onPointerMove}
          onPointerUp={handlers.onPointerUp} onPointerCancel={handlers.onPointerCancel}
          onKeyDown={(e) => { if (e.key === "Home" || e.key === "End") handlers.onKeyDown(e); }}>
          {items.map((it, i) => {
            const j = i - index;
            if (Math.abs(j) > SHOWN) return null;
            // Neighbors tuck behind the one you're on, a strip of each showing.
            const offset = j === 0 ? 0 : Math.sign(j) * (big + Math.abs(j) * size.strip);
            const style = {
              left: `calc(50% - ${size.w / 2}px + ${offset}px)`,
              top: (stageH - size.h) / 2,
              width: size.w, height: size.h,
              zIndex: 100 - Math.abs(j),
              transform: j === 0 ? `scale(${GROW})` : "none",
            } as CSSProperties;
            return (
              <button key={it.item.id} type="button" tabIndex={-1} className={`flat-item is-${kind}${j === 0 ? " is-front" : ""}`} style={style}
                aria-label={j === 0 ? `${it.title} by ${it.artist}` : `Flip to ${it.title} by ${it.artist}`}
                onClick={() => { if (!wasDrag() && j !== 0) setIndex(i); }}>
                <Cover it={it} kind={kind} />
              </button>
            );
          })}
        </div>
        <div className="flat-controls">
          <button type="button" className="mc-icon-btn flat-step" aria-label="Previous" disabled={index === 0} onClick={() => setIndex(index - 1)}>
            <ChevronLeft size={20} aria-hidden="true" />
          </button>
          <span className="numeral muted">{index + 1} of {items.length}</span>
          <button type="button" className="mc-icon-btn flat-step" aria-label="Next" disabled={index >= items.length - 1} onClick={() => setIndex(index + 1)}>
            <ChevronRight size={20} aria-hidden="true" />
          </button>
          <span className="caption muted">Use the ← → keys, scroll or drag to flip</span>
        </div>
      </div>
      <Holding it={front} go={go} />
    </div>
  );
}

/** What each format looks like: the album art, in its sleeve or case. */
function Cover({ it, kind }: { it: ShelfItem; kind: ShelfFormat }) {
  if (kind === "45s")
    return (
      <span className="paper-sleeve" style={{ background: it.color }}>
        <span className="paper-sleeve-print">{it.artist} · {it.title}</span>
        <span className="paper-sleeve-hole">
          <span className="paper-sleeve-label">{it.art ? <img src={it.art} alt="" /> : null}</span>
        </span>
      </span>
    );
  if (kind === "cds")
    return (
      <span className="cd-case">
        <span className="cd-hinge" />
        <Sleeve src={it.art} seed={it.seed} alt="" />
      </span>
    );
  if (kind === "cassettes")
    return (
      <span className="tape">
        <span className="tape-screw s1" /><span className="tape-screw s2" /><span className="tape-screw s3" /><span className="tape-screw s4" />
        <span className="tape-label">
          {/* The album cover, upright, cropped to fill the label. */}
          <span className="tape-art"><Sleeve src={it.art} seed={it.seed} alt="" /></span>
          <span className="tape-window">
            <span className="tape-reel full" />
            <span className="tape-ribbon" />
            <span className="tape-reel" />
          </span>
        </span>
        <span className="tape-foot"><i /><i /><i /><i /></span>
      </span>
    );
  return <Sleeve src={it.art} seed={it.seed} alt="" />;
}

/* ---------- The one you're on: title, play, remove ---------- */

function Holding({ it, go }: { it: ShelfItem; go: Go }) {
  const p = usePlayer();
  const lib = useLibrary();
  const playing = p.playing && it.tracks.some((t) => t.id === p.current?.id);
  const [sure, setSure] = useState(false);
  const [coverMsg, setCoverMsg] = useState("");
  useEffect(() => { setSure(false); setCoverMsg(""); }, [it.item.id]);
  return (
    <div className="shelf-holding" aria-live="polite">
      <span className="catalog eyebrow">{FORMAT_LABEL[it.item.format]}{it.year ? ` · ${it.year}` : ""}</span>
      <h2 className="display-md shelf-holding-title">{it.title}</h2>
      <span className="muted">{it.artist}</span>
      {it.item.note && <span className="caption muted">{it.item.note}</span>}
      {it.ripped && <span className="caption muted">Ripped to this computer · only you can see it</span>}
      {coverMsg && <span className="form-error" role="alert">{coverMsg}</span>}
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginTop: 6 }}>
        {it.tracks.length > 0 ? (
          <>
            <PlayButton playing={playing} onClick={() => (it.tracks.some((t) => t.id === p.current?.id) ? p.toggle() : p.playQueue(it.tracks))} />
            {it.release && <Button size="sm" onClick={() => go({ name: "album", releaseId: it.release!.id })}>Album page</Button>}
            {it.ripped && <Button size="sm" onClick={() => go({ name: "computer", album: it.ripped!.key })}>Open album</Button>}
            {it.ripped && (
              <Button size="sm" variant="ghost" onClick={() => { setCoverMsg(""); void changeRippedCover(it.ripped!, p.updateLocalTracks).then((e) => setCoverMsg(e ?? "")); }}>
                <ImagePlus size={14} aria-hidden="true" /> Change cover
              </Button>
            )}
          </>
        ) : (
          <span className="caption muted">{it.release ? "Coming soon on Milk Crate" : "Not on Milk Crate yet"}</span>
        )}
        {sure ? (
          <>
            <Button size="sm" variant="ghost" onClick={() => (it.ripped ? p.removeRippedCd(it.ripped.key) : void attempt(() => lib.removePhysical(it.item.id)))}>Take it off your shelf</Button>
            <button type="button" className="link-btn caption" onClick={() => setSure(false)}>Keep it</button>
          </>
        ) : (
          <button type="button" className="mc-icon-btn" aria-label={`Remove ${it.title} from your shelf`} title="Remove from your shelf" onClick={() => setSure(true)}>
            <Trash2 size={16} strokeWidth={1.75} aria-hidden="true" />
          </button>
        )}
      </div>
    </div>
  );
}

/* ---------- Adding to your shelf ---------- */

function AddToShelf({ defaultFormat = "LP", onAdded, intro }: { defaultFormat?: PhysicalFormat; onAdded: (f: PhysicalFormat) => void; intro: boolean }) {
  const c = useCatalog();
  const lib = useLibrary();
  const [format, setFormat] = useState<PhysicalFormat>(defaultFormat);
  const [query, setQuery] = useState("");
  const [manual, setManual] = useState(false);
  const [artistName, setArtistName] = useState("");
  const [title, setTitle] = useState("");
  const [msg, setMsg] = useState<{ kind: "info" | "error"; text: string } | null>(null);

  const q = query.trim().toLowerCase();
  const matches = q.length > 1
    ? c.releases.filter((r) => r.title.toLowerCase().includes(q) || c.artistById[r.artistId]?.name.toLowerCase().includes(q)).slice(0, 6)
    : [];

  const add = (item: Parameters<typeof lib.addPhysical>[0]) =>
    void attempt(async () => {
      await lib.addPhysical(item);
      setQuery(""); setArtistName(""); setTitle(""); setManual(false); setMsg(null);
      onAdded(item.format);
    }, (m) => setMsg({ kind: "error", text: m }));

  if (!lib.signedIn)
    return <div className="empty"><span>Your shelf lives in your account. Sign in to add the records, 45s, CDs and tapes you own.</span></div>;

  return (
    <section className="panel">
      <h2 className="display-md">{intro ? "Put your collection on the shelf" : "Add to your shelf"}</h2>
      {intro && <p className="muted">Add the records, 45s, CDs and tapes you own, and flip through them here like you would at home. If it's on Milk Crate, you can play it from the shelf.</p>}
      <div role="group" aria-label="Format" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {SHELF_SECTIONS.map((s) => (
          <button key={s.format} type="button" className="chip" aria-pressed={format === s.format} onClick={() => setFormat(s.format)}>{FORMAT_LABEL[s.format]}</button>
        ))}
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
                  <button key={r.id} type="button" className="pick-row" onClick={() => add({ format, releaseId: r.id })}>
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
            <label className="field"><span className="catalog eyebrow">Artist</span><input value={artistName} onChange={(e) => setArtistName(e.target.value)} maxLength={200} /></label>
            <label className="field"><span className="catalog eyebrow">Title</span><input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} /></label>
          </div>
          <div style={{ display: "flex", gap: 12 }}>
            <Button variant="primary" disabled={!title.trim()} onClick={() => add({ format, artistName: artistName.trim(), title: title.trim() })}>Add to your shelf</Button>
            <Button variant="ghost" onClick={() => setManual(false)}>Search Milk Crate instead</Button>
          </div>
        </>
      )}
      <p className="caption muted">If it's on Milk Crate, the digital album goes in your crate too.</p>
      {msg && <p role={msg.kind === "error" ? "alert" : "status"} className={msg.kind === "error" ? "form-error" : "form-info"}>{msg.text}</p>}
    </section>
  );
}
