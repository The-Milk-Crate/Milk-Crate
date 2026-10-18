import { useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import type { Go } from "../App";
import { useCatalog } from "../lib/catalog";
import { usePlayer } from "../lib/player";
import { sleeveSeed } from "../lib/sleeve";
import { inkOn } from "../lib/artistPage";
import type { Bin } from "../lib/bins";
import { distanceLabel, distanceWords } from "../lib/geo";
import { useUnits } from "../lib/location";
import { MARK_PATH, PlayButton, Button, Sleeve } from "./ui";
import { ArtistThumb } from "./ArtistBanner";
import { TownMap } from "./TownMap";
import { Map as MapIcon } from "lucide-react";

/** How many records behind the front one show their tops. */
const STACK_SHOWN = 6;
const STRIP = 20;

/**
 * A scene as record-store bins: one divider per town, nearest first. Open a
 * town's bin and flip through its records: the front one shows in full, the
 * rest stand behind it with their tops showing; click a top to pull that record
 * forward. Click the open town's tab again for a closer map of the town (and
 * again to go back to its bin). `centerTag` labels the first divider ("Home" for your town, "Here"
 * for a town you're looking around).
 */
export function CrateBins({ bins, centerTag, go }: { bins: Bin[]; centerTag: "Home" | "Here"; go: Go }) {
  const [selected, setSelected] = useState(bins[0]?.key);
  const [front, setFront] = useState(0);
  const [mapOpen, setMapOpen] = useState(false);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const units = useUnits();
  const index = Math.max(0, bins.findIndex((b) => b.key === selected));
  const bin = bins[index];
  if (!bin) return null;
  const next = bins.length > 1 ? bins[(index + 1) % bins.length] : null;

  const open = (i: number) => {
    if (i === index) return setMapOpen((m) => !m);
    setSelected(bins[i].key);
    setFront(0);
    setMapOpen(false);
  };
  const onTabKey = (e: KeyboardEvent, i: number) => {
    const to = e.key === "ArrowRight" ? i + 1 : e.key === "ArrowLeft" ? i - 1 : e.key === "Home" ? 0 : e.key === "End" ? bins.length - 1 : null;
    if (to === null) return;
    e.preventDefault();
    const j = (to + bins.length) % bins.length;
    if (j !== index) open(j);
    tabs.current[j]?.focus();
  };

  return (
    <div className="bins">
      <div role="tablist" aria-label="Towns in this scene" className="bins-rail">
        {bins.map((b, i) => {
          const on = i === index;
          const n = b.artists.length;
          return (
            <button key={b.key} ref={(el) => { tabs.current[i] = el; }} type="button" role="tab" id={`bin-tab-${i}`}
              aria-selected={on} aria-controls="bin-panel" tabIndex={on ? 0 : -1}
              title={on ? (mapOpen ? `Back to the ${b.place.name} bin` : `Click again for a map of ${b.place.name}`) : undefined}
              className={`bin-tab${b.isCenter && !n ? " is-empty" : ""}${b.miles > 60 ? " far" : ""}`}
              onClick={() => open(i)} onKeyDown={(e) => onTabKey(e, i)}>
              <span className="catalog">{b.isCenter ? centerTag : distanceLabel(b.miles, units)}</span>
              <span className="bin-tab-name" style={{ fontSize: b.place.name.length > 11 ? 18 : 22 }}>{b.place.name}</span>
              <span className="catalog">{n ? `${n} ${n === 1 ? "artist" : "artists"}` : "Empty bin"}</span>
              {b.isNew && !on && <span className="catalog bin-new" aria-label="New releases">New</span>}
              {on && <MapIcon className="bin-map-hint" size={15} strokeWidth={1.75} aria-hidden="true" data-open={mapOpen} />}
            </button>
          );
        })}
      </div>

      <section id="bin-panel" role="tabpanel" aria-labelledby={`bin-tab-${index}`} className="bin">
        {mapOpen ? (
          <TownMap bin={bin} bins={bins} sceneWord={centerTag === "Home" ? "your" : "this"} go={go} onClose={() => setMapOpen(false)}
            onOpenTown={(key) => { setSelected(key); setFront(0); }} />
        ) : bin.releases.length ? (
          <FullBin bin={bin} front={front} setFront={setFront} centerTag={centerTag} go={go} next={next} onNext={() => open((index + 1) % bins.length)} />
        ) : (
          <EmptyBin bin={bin} go={go} next={next} onNext={() => open((index + 1) % bins.length)} />
        )}
      </section>
    </div>
  );
}

function FullBin({ bin, front, setFront, go, next, onNext }: {
  bin: Bin; front: number; setFront: (i: number) => void; centerTag: string; go: Go; next: Bin | null; onNext: () => void;
}) {
  const c = useCatalog();
  const p = usePlayer();
  const n = bin.releases.length;
  const fi = front % n;
  const record = bin.releases[fi];
  const artistOf = (artistId: string) => c.artistById[artistId];
  const recordArtist = artistOf(record.artistId);
  const tracks = record.trackIds.map((id) => c.trackById[id]).filter(Boolean);
  const playingThis = tracks.some((t) => t.id === p.current?.id);
  // The records standing behind the front one, farthest first (drawn first, so nearer ones sit on top).
  const behind = Array.from({ length: Math.min(n - 1, STACK_SHOWN) }, (_, k) => (fi + 1 + k) % n).reverse();

  return (
    <div className="bin-full">
      <div className="bin-front">
        <div className="flip-stack" style={{ paddingTop: behind.length * STRIP }}>
          {behind.map((ri, j) => {
            const r = bin.releases[ri];
            const a = artistOf(r.artistId);
            const inset = (behind.length - j) * 6;
            const color = a?.accent ?? "#8a8a8a";
            return (
              <button key={r.id} type="button" className="flip-strip" onClick={() => setFront(ri)}
                aria-label={`Flip to ${r.title} by ${a?.name ?? ""}`} title={`${a?.name ?? ""} - ${r.title}`}
                style={{ top: j * STRIP, left: inset, right: inset, background: color, color: inkOn(color) }}>
                <Marquee text={a ? `${a.name} - ${r.title}` : r.title} delay={j * 1.3} />
              </button>
            );
          })}
          <button type="button" className="flip-front" onClick={() => go({ name: "album", releaseId: record.id })} aria-label={`Open ${record.title}`}>
            <Sleeve src={record.art} seed={sleeveSeed(record.title, recordArtist?.name ?? "")} alt={`${record.title} cover`} />
          </button>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
          <strong className="bin-title">{record.title}</strong>
          <span className="caption">{[recordArtist?.name, bin.place.name, record.year].filter(Boolean).join(" · ")}</span>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10 }}>
          <PlayButton playing={playingThis && p.playing} onClick={() => (playingThis ? p.toggle() : p.playQueue(tracks))} />
          <Button onClick={() => setFront((fi + 1) % n)} disabled={n < 2}>Flip to next</Button>
        </div>
        <span className="catalog muted bin-count" style={{ textTransform: "uppercase" }}>{fi + 1} of {n} in the {bin.place.name} bin</span>
      </div>

      <div className="bin-artists">
        <h2 className="display-md">In the {bin.place.name} bin</h2>
        {bin.artists.map(({ artist: a }) => {
          const count = c.releases.filter((r) => r.artistId === a.id).length;
          return (
            <button key={a.id} type="button" className="bin-artist" onClick={() => go({ name: "artist", artistId: a.id })}>
              <ArtistThumb artist={a} size={48} />
              <span style={{ flex: "1 1 auto", minWidth: 0, display: "flex", flexDirection: "column", textAlign: "left" }}>
                <span style={{ fontWeight: 650 }}>{a.name}</span>
                <span className="caption muted">{[a.genres.slice(0, 2).join(", "), `since ${a.since}`, `${count} ${count === 1 ? "release" : "releases"}`].filter(Boolean).join(" · ")}</span>
              </span>
            </button>
          );
        })}
        {next && <Button style={{ alignSelf: "flex-start", marginTop: 4 }} onClick={onNext}>Next bin: {next.place.name}</Button>}
      </div>
    </div>
  );
}

/**
 * One line of text that, when it doesn't fit, slides over to show its end and
 * back again (with a pause at each end). `delay` staggers neighbors so the
 * record tops don't all move in step. Holds still with reduced motion.
 */
function Marquee({ text, delay = 0 }: { text: string; delay?: number }) {
  const box = useRef<HTMLSpanElement>(null);
  const inner = useRef<HTMLSpanElement>(null);
  const [shift, setShift] = useState(0);
  useLayoutEffect(() => {
    const b = box.current, t = inner.current;
    if (!b || !t) return;
    const measure = () => setShift(Math.max(0, Math.ceil(t.scrollWidth - b.clientWidth)));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(b);
    return () => ro.disconnect();
  }, [text]);
  // About 28px a second while moving; moving takes 60% of the loop, pauses the rest.
  const seconds = Math.max(6, ((shift / 28) * 2) / 0.6);
  const style = shift ? ({ "--marquee-shift": `-${shift}px`, animationDuration: `${seconds}s`, animationDelay: `${delay}s` } as CSSProperties) : undefined;
  return (
    <span ref={box} className={`catalog marquee${shift ? " is-moving" : ""}`}>
      <span ref={inner} className="marquee-text" style={style}>{text}</span>
    </span>
  );
}

function EmptyBin({ bin, go, next, onNext }: { bin: Bin; go: Go; next: Bin | null; onNext: () => void }) {
  const units = useUnits();
  const name = bin.place.name;
  return (
    <div className="bin-empty">
      <div className="bin-empty-art" aria-hidden="true">
        <svg viewBox="0 0 64 64" width="120" height="120"><path d={MARK_PATH} fillRule="evenodd" fill="currentColor" /></svg>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 14, maxWidth: 520, flex: "999 1 320px" }}>
        <h2 className="display-md">Nothing in the {name} bin yet</h2>
        <p className="muted">
          When a band from {name} puts out music on Milk Crate, it lands here first.
          {next ? ` Until then, the nearest bin is ${next.place.name}, ${distanceWords(next.miles, units)} away.` : " No other towns in this scene have bands yet either."}
        </p>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 16 }}>
          {next && <Button variant="primary" onClick={onNext}>Flip to {next.place.name}</Button>}
          <Button onClick={() => go({ name: "upload" })}>Make music in {name}? Apply as an artist</Button>
        </div>
      </div>
    </div>
  );
}
