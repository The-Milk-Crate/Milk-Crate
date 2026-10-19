import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { Check } from "lucide-react";
import type { Go } from "../App";
import { useLocation } from "../lib/location";
import { useLibrary } from "../lib/library";
import { Button, MARK_PATH } from "./ui";

/** Ask the app to show the tutorial again (Settings has a button for it). */
export const replayTutorial = () => window.dispatchEvent(new Event("mc:tutorial"));

/** Space between the highlight and the bubble, and from the bubble to the window's edge. */
const GAP = 16;
const EDGE = 16;
const FAVORITE_GOAL = 3;

type Side = "right" | "left" | "top" | "bottom";
/** `pad`: even space between the ring and what it surrounds, sized to the gaps around it so the ring never touches nearby text. */
interface Stop { id: string; targets: string; title: string; body: (town: string) => string; prefer: Side[]; pad: number }

/** The tour's stops, top of the sidebar to the bottom, then the player. Each names what it highlights. */
const STOPS: Stop[] = [
  { id: "home", pad: 0, targets: '[data-tour="home"]', prefer: ["right", "bottom"], title: "Home",
    body: () => "What you keep coming back to, new releases (the ones from your scene say Near you), and artists to discover." },
  { id: "crate", pad: 0, targets: '[data-tour="crate"]', prefer: ["right", "bottom"], title: "Your Crate",
    body: () => "Albums and songs you save, your playlists and favorites. Your star ratings live here and steer shuffle. Your Computer plays files from this computer; nothing is uploaded." },
  { id: "shelf", pad: 0, targets: '[data-tour="shelf"]', prefer: ["right", "bottom"], title: "Your Shelf",
    body: () => "Catalog your vinyl, 45s, CDs and tapes. If a record is on Milk Crate, the digital album lands in your crate too. Rip a CD and it plays straight from this computer." },
  { id: "scenes", pad: 0, targets: '[data-tour="scenes"], [data-tour="artist"]', prefer: ["right", "top"], title: "Scenes and Artists",
    body: (town) => `Your scene is ${town}, the towns within 35 miles and your state's bigger cities, on a real map. Every band is a dot in its own color. Artists shows who you follow and who sounds like them.` },
  { id: "player", pad: 8, targets: ".mc-player-center", prefer: ["top", "bottom"], title: "The player",
    body: () => "Drag the seek bar and volume, shape the sound with the EQ button, and see what's up next in the queue." },
  { id: "immersive", pad: 6, targets: '[data-tour="immersive"]', prefer: ["top", "left"], title: "Immersive mode",
    body: () => "The album full screen with its colors swirling behind it. Open the library on the left edge to change music without leaving." },
];

interface Box { x: number; y: number; w: number; h: number; r: number }

/** The box around everything a stop names (visible parts only), padded evenly and kept on screen. */
function measure(selector: string, pad = 0): Box | null {
  const els = [...document.querySelectorAll<HTMLElement>(selector)].filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
  if (!els.length) return null;
  const rects = els.map((el) => el.getBoundingClientRect());
  const l = Math.min(...rects.map((r) => r.left)) - pad, t = Math.min(...rects.map((r) => r.top)) - pad;
  const r = Math.max(...rects.map((r) => r.right)) + pad, b = Math.max(...rects.map((r) => r.bottom)) + pad;
  const x = Math.max(4, l), y = Math.max(4, t);
  // Corners follow the part's own, grown by the padding, so the ring sits the same distance all the way round.
  const corner = parseFloat(getComputedStyle(els[0]).borderTopLeftRadius) || 10;
  return { x, y, w: Math.min(window.innerWidth - 4, r) - x, h: Math.min(window.innerHeight - 4, b) - y, r: corner + pad };
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * Where the bubble goes: beside the highlight on the first side it fits, never over it, and inside the
 * window. The arrow points at the middle of the highlight.
 */
function place(box: Box, w: number, h: number, prefer: Side[]) {
  const vw = window.innerWidth, vh = window.innerHeight;
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
  const at: Record<Side, () => { x: number; y: number; ok: boolean }> = {
    right: () => ({ x: box.x + box.w + GAP, y: clamp(cy - h / 2, EDGE, vh - h - EDGE), ok: box.x + box.w + GAP + w <= vw - EDGE }),
    left: () => ({ x: box.x - GAP - w, y: clamp(cy - h / 2, EDGE, vh - h - EDGE), ok: box.x - GAP - w >= EDGE }),
    top: () => ({ x: clamp(cx - w / 2, EDGE, vw - w - EDGE), y: box.y - GAP - h, ok: box.y - GAP - h >= EDGE }),
    bottom: () => ({ x: clamp(cx - w / 2, EDGE, vw - w - EDGE), y: box.y + box.h + GAP, ok: box.y + box.h + GAP + h <= vh - EDGE }),
  };
  const order = [...prefer, ...(["right", "left", "top", "bottom"] as Side[]).filter((s) => !prefer.includes(s))];
  for (const side of order) {
    const p = at[side]();
    if (!p.ok) continue;
    const vertical = side === "left" || side === "right";
    const arrow = vertical ? clamp(cy - p.y, 22, h - 22) : clamp(cx - p.x, 22, w - 22);
    return { x: p.x, y: p.y, side, arrow };
  }
  return { x: clamp(cx - w / 2, EDGE, vw - w - EDGE), y: vh - h - EDGE, side: null, arrow: 0 };
}

/**
 * First run, after picking your city: three intro cards, then a tour that highlights each part of the
 * app with a glass bubble beside it, then the getting-started checklist. Shown once; Settings can replay it.
 */
export function Tutorial({ go, onClose }: { go: Go; onClose: () => void }) {
  const loc = useLocation();
  const lib = useLibrary();
  const town = loc.home ? `${loc.home.name}, ${loc.home.state}` : "your town";
  const [phase, setPhase] = useState<"intro" | "tour" | "done">("intro");
  const [card, setCard] = useState(0);
  const [step, setStep] = useState(0);
  const [box, setBox] = useState<Box | null>(null);
  const [tip, setTip] = useState<ReturnType<typeof place> | null>(null);
  // The bubble glides between stops, but appears in place the first time (not sliding in from nowhere).
  const [glide, setGlide] = useState(false);
  useEffect(() => {
    if (!tip) return;
    const raf = requestAnimationFrame(() => setGlide(true));
    return () => cancelAnimationFrame(raf);
  }, [tip]);
  const tipRef = useRef<HTMLDivElement>(null);
  const primary = useRef<HTMLButtonElement>(null);

  // Stops whose part isn't on screen (a narrow window, say) are skipped.
  const [stops, setStops] = useState<Stop[]>(STOPS);
  const stop = stops[step];

  useEffect(() => { go({ name: "home" }); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Esc ends it.
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close.current(); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  useEffect(() => { primary.current?.focus({ preventScroll: true }); }, [phase, card, step]);

  // Measure the highlighted part now and whenever the window changes.
  const remeasure = useCallback(() => {
    if (phase !== "tour" || !stop) return;
    setBox(measure(stop.targets, stop.pad));
  }, [phase, stop]);
  useEffect(() => {
    if (phase !== "tour") return;
    const live = STOPS.filter((s) => measure(s.targets));
    setStops(live.length ? live : STOPS);
  }, [phase]);
  useEffect(() => {
    remeasure();
    const raf = requestAnimationFrame(remeasure); // after the sidebar settles
    window.addEventListener("resize", remeasure);
    return () => { cancelAnimationFrame(raf); window.removeEventListener("resize", remeasure); };
  }, [remeasure]);
  // Then place the bubble beside it, once its size is known.
  useLayoutEffect(() => {
    const el = tipRef.current;
    if (!box || !el || !stop) return setTip(null);
    setTip(place(box, el.offsetWidth, el.offsetHeight, stop.prefer));
  }, [box, stop]);

  const nextStep = () => (step + 1 < stops.length ? setStep(step + 1) : setPhase("done"));

  if (phase === "intro") {
    return (
      <div className="tut-veil" role="dialog" aria-modal="true" aria-label="Welcome to Milk Crate">
        <div key={card} className="tut-card">
          {card === 0 && (
            <>
              <div className="tut-art tut-art-glow">
                <svg viewBox="0 0 64 64" width="92" height="92" aria-hidden="true"><path d={MARK_PATH} fillRule="evenodd" fill="currentColor" /></svg>
              </div>
              <span className="catalog eyebrow">Welcome</span>
              <h2 className="tut-title">Welcome to Milk Crate.</h2>
              <p className="tut-body">Streaming that feels like digging through a record store's crates: local scenes, the records on your shelf, buying straight from artists, and no charts.</p>
            </>
          )}
          {card === 1 && (
            <>
              <div className="tut-art">
                <div className="tut-flow" aria-hidden="true">
                  <span className="tut-node"><svg viewBox="0 0 24 24" width="24" height="24"><circle cx="12" cy="8" r="5" /><path d="M20 21a8 8 0 0 0-16 0" /></svg><span className="catalog">You</span></span>
                  <svg className="tut-arrow" viewBox="0 0 70 16" width="70" height="16"><path d="M2 8h60m-8-6 8 6-8 6" /></svg>
                  <span className="tut-node on"><svg viewBox="0 0 24 24" width="24" height="24"><path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" /></svg><span className="catalog">The artists you play</span></span>
                </div>
              </div>
              <span className="catalog eyebrow">A nonprofit</span>
              <h2 className="tut-title">Built for artists, not shareholders.</h2>
              <p className="tut-body">Your subscription goes to the artists you actually listen to. You can also buy an album outright, or become a Fan of a band to unlock everything they put out.</p>
            </>
          )}
          {card === 2 && (
            <>
              <div className="tut-art tut-art-grid">
                <svg viewBox="0 0 420 130" width="420" height="130" aria-hidden="true">
                  <circle cx="210" cy="66" r="44" className="tut-ring" />
                  <circle cx="210" cy="66" r="7" className="tut-home" />
                  {[[182, 48, "#e3b052"], [238, 84, "#8fc7e8"], [226, 40, "#e88f8f"], [190, 92, "#b9d27a"], [120, 30, "#d7a6e8"], [320, 100, "#f0c27a"], [80, 96, "#8fc7e8"], [350, 36, "#b9d27a"]].map(([x, y, c], i) => (
                    <circle key={i} cx={x} cy={y} r={i < 4 ? 5 : 4} fill={c as string} opacity={i < 4 ? 1 : 0.65} />
                  ))}
                </svg>
              </div>
              <span className="catalog eyebrow">No charts</span>
              <h2 className="tut-title">No top 100. Just your scene.</h2>
              <p className="tut-body">The bands around {town} come first, every one a dot on a real map. And your own star ratings decide what shuffle plays.</p>
            </>
          )}
          <div className="tut-foot">
            <div className="tut-dots" aria-label={`Card ${card + 1} of 3`}>{[0, 1, 2].map((i) => <span key={i} className={i === card ? "on" : ""} />)}</div>
            <div className="tut-actions">
              {card === 1
                ? <Button variant="ghost" onClick={() => setCard(0)}>Back</Button>
                : <Button variant="ghost" onClick={() => setPhase("done")}>{card === 2 ? "Skip the tour" : "Skip"}</Button>}
              {card < 2
                ? <Button ref={primary} variant="primary" onClick={() => setCard(card + 1)}>Next</Button>
                : <Button ref={primary} variant="primary" onClick={() => { setStep(0); setPhase("tour"); }}>Show me around</Button>}
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (phase === "done") {
    const checks = [
      { ok: !!loc.home, title: "Set your town", body: loc.home ? `${town}. Your scene is built around it.` : "Your scene is built around it." },
      { ok: lib.favorites.length >= FAVORITE_GOAL, title: `Favorite ${FAVORITE_GOAL} songs`, body: "Tap the heart: favorites come up more when you shuffle." },
      { ok: lib.following.length > 0, title: "Follow a local band", body: "Their new releases show up in New, first." },
    ];
    return (
      <div className="tut-veil" role="dialog" aria-modal="true" aria-label="You're all set">
        <div className="tut-card">
          <span className="catalog eyebrow">You're all set</span>
          <h2 className="tut-title">Make it yours.</h2>
          <p className="tut-body">Three things that make Milk Crate feel like yours. They tick themselves off as you go, and stay on Home until they're done.</p>
          <ul className="tut-checks">
            {checks.map((c) => (
              <li key={c.title} className={c.ok ? "ok" : ""}>
                <span className="tut-box" aria-hidden="true">{c.ok && <Check size={13} strokeWidth={3} />}</span>
                <span className="tut-check-text"><strong>{c.title}{c.ok && <span className="visually-hidden"> (done)</span>}</strong><span className="caption muted">{c.body}</span></span>
              </li>
            ))}
          </ul>
          <div className="tut-foot">
            <span className="caption muted">Replay this any time in Settings.</span>
            <Button ref={primary} variant="primary" onClick={onClose}>Start listening</Button>
          </div>
        </div>
      </div>
    );
  }

  // The tour: everything dims except the highlighted part; clicks elsewhere are held off.
  const tipStyle: CSSProperties = tip ? { left: tip.x, top: tip.y } : { left: -9999, top: 0, visibility: "hidden" };
  const arrowStyle: CSSProperties | undefined = tip?.side
    ? tip.side === "right" ? { left: -8, top: tip.arrow - 7, transform: "rotate(-45deg)" }
      : tip.side === "left" ? { right: -8, top: tip.arrow - 7, transform: "rotate(135deg)" }
      : tip.side === "top" ? { bottom: -8, left: tip.arrow - 7, transform: "rotate(225deg)" }
      : { top: -8, left: tip.arrow - 7, transform: "rotate(45deg)" }
    : undefined;
  return (
    <div className="tut-tour">
      <div className="tut-block" aria-hidden="true" />
      {box && <div className="tut-spot" aria-hidden="true" style={{ left: box.x, top: box.y, width: box.w, height: box.h, borderRadius: box.r }} />}
      <div ref={tipRef} className={`tut-tip${tip && glide ? " glides" : ""}`} role="dialog" aria-modal="true" aria-labelledby="tut-tip-title" style={tipStyle}>
        {arrowStyle && <span className="tut-tip-arrow" aria-hidden="true" style={arrowStyle} />}
        <div key={stop?.id} className="tut-tip-body">
          <span className="catalog eyebrow">{step + 1} of {stops.length}</span>
          <h3 id="tut-tip-title" className="tut-tip-title">{stop?.title}</h3>
          <p className="caption muted tut-tip-text">{stop?.body(town)}</p>
        </div>
        <div className="tut-foot">
          <Button size="sm" variant="ghost" onClick={() => setPhase("done")}>Skip tour</Button>
          <div className="tut-actions">
            {step > 0 && <Button size="sm" onClick={() => setStep(step - 1)}>Back</Button>}
            <Button ref={primary} size="sm" variant="primary" onClick={nextStep}>{step + 1 < stops.length ? "Next" : "Finish"}</Button>
          </div>
        </div>
      </div>
    </div>
  );
}
