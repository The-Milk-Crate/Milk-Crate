import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import "@fontsource/permanent-marker/latin-400.css";
import { Plus, Trash2, Volume2, VolumeX } from "lucide-react";
import type { Go, ShelfFormat } from "../App";
import { useCatalog } from "../lib/catalog";
import { usePlayer } from "../lib/player";
import { FORMAT_LABEL, attempt, useLibrary, type PhysicalItem } from "../lib/library";
import { sleeveSeed } from "../lib/sleeve";
import { SHELF_SECTIONS, flipSound, ownedSections, setShelfSounds, shelfSoundsOn, spineColor, useFlipper } from "../lib/shelf";
import type { PhysicalFormat, Release, Track } from "../lib/types";
import { Button, PlayButton, Sleeve } from "../components/ui";

/** One thing on your shelf, with what's needed to draw and play it. */
interface ShelfItem {
  item: PhysicalItem;
  release?: Release;
  title: string;
  artist: string;
  art?: string;
  seed: string;
  /** Spine, label and paper color. */
  color: string;
  tracks: Track[];
}

function useShelfItems(format?: PhysicalFormat): ShelfItem[] {
  const c = useCatalog();
  const lib = useLibrary();
  return useMemo(() => lib.physical.filter((x) => !format || x.format === format).map((item) => {
    const release = item.releaseId ? c.releaseById[item.releaseId] : undefined;
    const a = release ? c.artistById[release.artistId] : undefined;
    const title = release?.title ?? item.title;
    const artist = a?.name ?? item.artistName;
    const seed = sleeveSeed(title, artist);
    return {
      item, release, title, artist, art: release?.art, seed,
      color: a?.accent ?? spineColor(seed),
      tracks: (release?.trackIds ?? []).map((id) => c.trackById[id]).filter(Boolean),
    };
  }), [lib.physical, format, c.releaseById, c.artistById, c.trackById]);
}

/** Is this item's album the one playing right now? */
function usePlayingItem(it?: ShelfItem) {
  const p = usePlayer();
  return !!it && p.playing && it.tracks.some((t) => t.id === p.current?.id);
}

/**
 * Your Shelf: your records, 45s, CDs and tapes, each kept the way they would be
 * at home. Flip through records in a milk crate, thumb through CDs, pull a tape
 * off the rack. Sections only show when you have something in them.
 */
export function Shelf({ go, format }: { go: Go; format?: ShelfFormat }) {
  const lib = useLibrary();
  const all = useShelfItems();
  const sections = ownedSections(lib.physical.map((x) => x.format));
  const current = sections.find((s) => s.id === format) ?? sections[0];
  const [adding, setAdding] = useState(false);
  const [sounds, setSounds] = useState(shelfSoundsOn);
  const items = useShelfItems(current?.format);
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

      {current && (
        <>
          {sections.length > 1 && (
            <div role="tablist" aria-label="Your shelf" className="shelf-dividers">
              {sections.map((s) => (
                <button key={s.id} type="button" role="tab" className="shelf-divider" aria-selected={s.id === current.id}
                  onClick={() => go({ name: "shelf", format: s.id })}>
                  {s.label}
                </button>
              ))}
            </div>
          )}
          <section className="shelf-section" aria-label={current.label}>
            {current.id === "vinyl" && <RecordCrate key="lp" items={items} size="lp" go={go} />}
            {current.id === "45s" && <RecordCrate key="45" items={items} size="45" go={go} />}
            {current.id === "cds" && <CdRack items={items} go={go} />}
            {current.id === "cassettes" && <TapeRack items={items} go={go} />}
          </section>
        </>
      )}
    </div>
  );
}

/* ---------- What you're holding: title, play, remove ---------- */

function Holding({ it, go, children, hint }: { it: ShelfItem; go: Go; children?: ReactNode; hint?: string }) {
  const p = usePlayer();
  const lib = useLibrary();
  const playing = usePlayingItem(it);
  const [sure, setSure] = useState(false);
  useEffect(() => setSure(false), [it.item.id]);
  return (
    <div className="shelf-holding" aria-live="polite">
      <span className="catalog eyebrow">{FORMAT_LABEL[it.item.format]}{it.release?.year ? ` · ${it.release.year}` : ""}</span>
      <h2 className="display-md shelf-holding-title">{it.title}</h2>
      <span className="muted">{it.artist}</span>
      {it.item.note && <span className="caption muted">{it.item.note}</span>}
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginTop: 6 }}>
        {it.tracks.length > 0 ? (
          <>
            <PlayButton playing={playing} onClick={() => (it.tracks.some((t) => t.id === p.current?.id) ? p.toggle() : p.playQueue(it.tracks))} />
            {it.release && <Button size="sm" onClick={() => go({ name: "album", releaseId: it.release!.id })}>Album page</Button>}
          </>
        ) : (
          <span className="caption muted">{it.release ? "Coming soon on Milk Crate" : "Not on Milk Crate yet"}</span>
        )}
        {sure ? (
          <>
            <Button size="sm" variant="ghost" onClick={() => void attempt(() => lib.removePhysical(it.item.id))}>Take it off your shelf</Button>
            <button type="button" className="link-btn caption" onClick={() => setSure(false)}>Keep it</button>
          </>
        ) : (
          <button type="button" className="mc-icon-btn" aria-label={`Remove ${it.title} from your shelf`} title="Remove from your shelf" onClick={() => setSure(true)}>
            <Trash2 size={16} strokeWidth={1.75} aria-hidden="true" />
          </button>
        )}
      </div>
      {children}
      {hint && <span className="caption muted shelf-hint">{hint}</span>}
    </div>
  );
}

const countLabel = (i: number, n: number) => `${i + 1} of ${n}`;

/* ---------- Vinyl and 45s: flipping through a crate ---------- */

/**
 * Records standing in a crate. Scroll, drag down or use the arrow keys to tip
 * the front record toward you and see the next one. Click the front record to
 * pull it out: the disc slides out of its sleeve, and spins while it plays.
 * 45s stand in their own carrying case, in paper sleeves with a hole that shows the label.
 */
function RecordCrate({ items, size, go }: { items: ShelfItem[]; size: "lp" | "45"; go: Go }) {
  const { index, setIndex, wasDrag, handlers } = useFlipper(items.length, { step: size === "lp" ? 44 : 36, onFlip: () => flipSound("sleeve") });
  const [pulled, setPulled] = useState(false);
  useEffect(() => setPulled(false), [index]);
  const front = items[index];
  const spinning = usePlayingItem(front);
  if (!front) return null;
  const noun = size === "lp" ? "record" : "45";

  return (
    <div className={`crate-dig is-${size}`}>
      <div className="crate-stage" tabIndex={0} role="group" aria-roledescription={size === "lp" ? "record crate" : "45 case"}
        aria-label={`${items.length} ${noun}s. Scroll, drag or use the arrow keys to flip. Enter pulls the front one out.`}
        {...handlers}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setPulled((x) => !x); flipSound("sleeve"); return; }
          if (e.key === "Escape") { setPulled(false); return; }
          handlers.onKeyDown(e);
        }}>
        <div className="crate-records">
          {items.map((it, i) => {
            const d = i - index;
            if (d < -3 || d > 11) return null;
            return (
              <Record key={it.item.id} it={it} d={d} size={size} pulled={d === 0 && pulled} spinning={d === 0 && spinning}
                onClick={() => {
                  if (wasDrag()) return;
                  if (d === 0) { setPulled((x) => !x); flipSound("sleeve"); } else setIndex(i);
                }} />
            );
          })}
          {size === "lp" ? <MilkCrateFront /> : <CaseFront />}
        </div>
      </div>
      <Holding it={front} go={go} hint={`${countLabel(index, items.length)} · scroll or drag to flip, click the front ${noun} to pull it out`}>
        <div style={{ display: "flex", gap: 8 }}>
          <Button size="sm" variant="ghost" disabled={index === 0} onClick={() => setIndex(index - 1)}>Back</Button>
          <Button size="sm" disabled={index >= items.length - 1} onClick={() => setIndex(index + 1)}>Flip</Button>
        </div>
      </Holding>
    </div>
  );
}

function Record({ it, d, size, pulled, spinning, onClick }: { it: ShelfItem; d: number; size: "lp" | "45"; pulled: boolean; spinning: boolean; onClick: () => void }) {
  // The label's words only where you can see them: out of the sleeve, or through a 45's hole.
  const showLabel = d === 0 && (pulled || size === "45");
  // Behind the front record: standing, tops showing. In front: tipped toward you.
  const transform =
    d < 0 ? `translateZ(${10 - d * 4}px) rotateX(${-58 - Math.min(3, -d) * 6}deg)`
    : d === 0 ? (pulled ? "translateY(-40%) translateZ(90px) rotateX(0deg)" : "rotateX(-4deg)")
    : `translateY(${-d * (size === "lp" ? 15 : 12)}px) translateZ(${-d * 20}px) rotateX(2deg)`;
  const style = {
    transform,
    opacity: d < -1 ? 0 : 1,
    zIndex: d < 0 ? 50 + d : 40 - d,
    "--label": it.color,
  } as CSSProperties;
  return (
    <button type="button" className={`record${d === 0 ? " is-front" : ""}${pulled ? " is-pulled" : ""}${spinning ? " is-spinning" : ""}`} style={style}
      onClick={onClick} tabIndex={-1} aria-label={d === 0 ? `${pulled ? "Put back" : "Pull out"} ${it.title}` : `Flip to ${it.title} by ${it.artist}`}>
      <span className="record-disc" aria-hidden="true">
        <span className="record-label">{it.art ? <img src={it.art} alt="" /> : showLabel ? <span className="record-label-text">{it.title}</span> : null}</span>
      </span>
      {size === "lp" ? (
        <span className="record-sleeve"><Sleeve src={it.art} seed={it.seed} alt="" /></span>
      ) : (
        <span className="record-sleeve paper-sleeve" style={{ background: it.color }}>
          <span className="paper-sleeve-print">{it.artist} · {it.title}</span>
        </span>
      )}
      <span className="record-top" aria-hidden="true">{it.artist} · {it.title}</span>
    </button>
  );
}

/** The front of a milk crate (with its holes), in front of the records. */
function MilkCrateFront() {
  const cols = 6;
  const holes = Array.from({ length: cols * 2 }, (_, i) => {
    const x = 18 + (i % cols) * 60;
    const y = i < cols ? 18 : 62;
    return `M${x + 6} ${y}h36a6 6 0 0 1 6 6v20a6 6 0 0 1-6 6h-36a6 6 0 0 1-6-6v-20a6 6 0 0 1 6-6z`;
  }).join("");
  return (
    <svg className="crate-front" viewBox="0 0 384 112" preserveAspectRatio="none" aria-hidden="true">
      <path fillRule="evenodd" d={`M10 0h364a10 10 0 0 1 10 10v92a10 10 0 0 1-10 10h-364a10 10 0 0 1-10-10v-92a10 10 0 0 1 10-10z${holes}`} />
    </svg>
  );
}

/** The front of a 45s carrying case, with its latch. */
function CaseFront() {
  return (
    <div className="crate-front case-front" aria-hidden="true">
      <span className="case-latch" />
      <span className="case-label catalog">45 RPM</span>
    </div>
  );
}

/* ---------- CDs: thumbing through jewel cases ---------- */

/**
 * Jewel cases in a row, the one you're on facing you and the rest angled away
 * like spines on a rack. Scroll, drag sideways or use the arrow keys to thumb
 * through. Click the one facing you to open the case: the booklet swings open
 * on its hinge (with the songs inside), and the disc spins while it plays.
 */
function CdRack({ items, go }: { items: ShelfItem[]; go: Go }) {
  const c = useCatalog();
  const { index, setIndex, wasDrag, handlers } = useFlipper(items.length, { step: 60, axis: "x", onFlip: () => flipSound("case") });
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [index]);
  const front = items[index];
  const spinning = usePlayingItem(front);
  if (!front) return null;
  return (
    <div className="cd-dig">
      <div className="cd-stage" tabIndex={0} role="group" aria-roledescription="CD rack"
        aria-label={`${items.length} CDs. Scroll, drag or use the arrow keys to thumb through. Enter opens the case.`}
        {...handlers}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpen((x) => !x); flipSound("case"); return; }
          if (e.key === "Escape") { setOpen(false); return; }
          handlers.onKeyDown(e);
        }}>
        <div className="cd-row">
          {items.map((it, i) => {
            const d = i - index;
            if (Math.abs(d) > 8) return null;
            const side = Math.sign(d);
            // An open case swings its booklet out to the left, so it moves right to make room.
            const shift = open ? 110 : 0;
            const transform = d === 0
              ? `translateX(${shift}px) translateZ(${open ? 20 : 70}px) rotateY(0deg)`
              : `translateX(${side * (150 + (Math.abs(d) - 1) * 38) + (side > 0 ? shift : -shift)}px) translateZ(-60px) rotateY(${-side * 68}deg)`;
            const songs = it.tracks.length ? it.tracks : (it.release?.trackIds ?? []).map((id) => c.trackById[id]).filter(Boolean);
            return (
              <button key={it.item.id} type="button" tabIndex={-1} className={`jewel${d === 0 ? " is-front" : ""}${d === 0 && open ? " is-open" : ""}${d === 0 && spinning ? " is-spinning" : ""}`}
                style={{ transform, zIndex: 50 - Math.abs(d), "--label": it.color } as CSSProperties}
                aria-label={d === 0 ? `${open ? "Close" : "Open"} the case for ${it.title}` : `Flip to ${it.title} by ${it.artist}`}
                onClick={() => {
                  if (wasDrag()) return;
                  if (d === 0) { setOpen((x) => !x); flipSound("case"); } else setIndex(i);
                }}>
                <span className="jewel-tray" aria-hidden="true">
                  <span className="cd-disc"><span className="cd-label">{it.art ? <img src={it.art} alt="" /> : null}</span></span>
                </span>
                <span className="jewel-lid" aria-hidden="true">
                  <span className="jewel-cover"><Sleeve src={it.art} seed={it.seed} alt="" /></span>
                  {d === 0 && (
                    <span className="jewel-booklet">
                      <span className="jewel-booklet-title">{it.title}</span>
                      <span className="jewel-booklet-artist">{it.artist}</span>
                      {songs.length > 0 && <ol>{songs.slice(0, 14).map((t) => <li key={t.id}>{t.title}</li>)}</ol>}
                    </span>
                  )}
                </span>
              </button>
            );
          })}
        </div>
      </div>
      <Holding it={front} go={go} hint={`${countLabel(index, items.length)} · scroll or drag sideways to thumb through, click the CD in front to open it`}>
        <div style={{ display: "flex", gap: 8 }}>
          <Button size="sm" variant="ghost" disabled={index === 0} onClick={() => setIndex(index - 1)}>Previous</Button>
          <Button size="sm" disabled={index >= items.length - 1} onClick={() => setIndex(index + 1)}>Next</Button>
        </div>
      </Holding>
    </div>
  );
}

/* ---------- Cassettes: a tape rack on the wall ---------- */

/**
 * Tapes on a rack, spines out. Hover nudges one forward; click (or the arrow
 * keys and Enter) slides it off the rack so you can see the tape itself,
 * label written by hand, reels turning while it plays.
 */
function TapeRack({ items, go }: { items: ShelfItem[]; go: Go }) {
  const { index, setIndex, handlers } = useFlipper(items.length, { onFlip: () => flipSound("tape") });
  const it = items[index];
  const spinning = usePlayingItem(it);
  if (!it) return null;
  return (
    <div className="tape-dig">
      <div className="tape-rack" tabIndex={0} role="listbox" aria-label={`Tape rack, ${items.length} tapes. Use the arrow keys to pick one.`}
        aria-activedescendant={`tape-${it.item.id}`} onKeyDown={handlers.onKeyDown}>
        {items.map((x, i) => (
          <div key={x.item.id} className="tape-slot">
            <button type="button" id={`tape-${x.item.id}`} role="option" aria-selected={i === index} tabIndex={-1}
              className={`tape-spine${i === index ? " is-out" : ""}`} style={{ "--label": x.color } as CSSProperties} onClick={() => setIndex(i)}>
              <span className="tape-spine-band" />
              <span className="tape-spine-text"><strong>{x.artist}</strong> {x.title}</span>
              <span className="tape-spine-logo catalog">C60</span>
            </button>
          </div>
        ))}
        {Array.from({ length: Math.max(0, 8 - items.length) }, (_, i) => <div key={`empty-${i}`} className="tape-slot is-empty" aria-hidden="true" />)}
      </div>
      <Holding it={it} go={go} hint={`${countLabel(index, items.length)} · click a spine or use the arrow keys to take a tape off the rack`}>
        <div className="tape-out" key={it.item.id}>
          <div className="tape-jcard"><Sleeve src={it.art} seed={it.seed} alt="" /></div>
          <Cassette it={it} spinning={spinning} />
        </div>
      </Holding>
    </div>
  );
}

function Cassette({ it, spinning }: { it: ShelfItem; spinning: boolean }) {
  return (
    <div className={`cassette${spinning ? " is-spinning" : ""}`} style={{ "--label": it.color } as CSSProperties} aria-hidden="true">
      <span className="cassette-screw s1" /><span className="cassette-screw s2" /><span className="cassette-screw s3" /><span className="cassette-screw s4" />
      <span className="cassette-label">
        <span className="cassette-band" />
        <span className="cassette-title">{it.title}</span>
        <span className="cassette-side catalog">A</span>
        <span className="cassette-window">
          <span className="cassette-reel left" />
          <span className="cassette-tape" />
          <span className="cassette-reel right" />
        </span>
      </span>
      <span className="cassette-foot"><i /><i /><i /><i /></span>
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
