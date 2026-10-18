/**
 * Milk Crate's scroll bars: a frosted glass pill and nothing else (no track, no arrows),
 * on every scroll area in the app, including ones added later.
 *
 * The system scroll bars are hidden (styles in app.css) and each scroll area gets an
 * overlay "thumb" placed next to it, so the scroll area's own layout and positioning
 * are left alone. The thumb is frosted with backdrop-filter, which the system scroll
 * bar can't do.
 *
 * Also:
 * - The mouse wheel scrolls a sideways row (like Recently Played) while you hover it or its bar.
 * - The arrow keys scroll whatever you're hovering (or what has focus): ←/→ sideways, ↑/↓ up and down.
 *   Screens that use the arrows themselves (Your Shelf, tabs, sliders) still get them first.
 */

type Axis = "x" | "y";

interface Area {
  el: HTMLElement;
  thumbs: Partial<Record<Axis, HTMLElement>>;
  resize: ResizeObserver;
  /** Big rounded panel this area fills: its up-and-down pill sits just outside it, clear of the round corners. */
  frame: HTMLElement | null;
}

const THICK = 10;  // px, across the bar
const INSET = 4;   // px from the scroll area's edges
const MIN_LEN = 36; // px, shortest the pill gets
const OUT_THICK = 6; // px, a pill beside a panel (it sits in the gap between panels)
const OUT_GAP = 2;   // px between the panel's edge and that pill

/**
 * The rounded panel a tall scroll area fills along its right side (the area itself, or a clipping
 * parent with matching edges), when there's room beside it for the pill. Otherwise null.
 */
function findFrame(el: HTMLElement): HTMLElement | null {
  const r = el.getBoundingClientRect();
  if (r.height < 240) return null;
  let n: HTMLElement | null = el;
  for (let depth = 0; n && depth < 3; depth++, n = n.parentElement) {
    const nr = n.getBoundingClientRect();
    if (nr.right - r.right > 4) return null;
    const cs = getComputedStyle(n);
    const clips = n === el || cs.overflowX !== "visible";
    if (clips && parseFloat(cs.borderTopRightRadius) >= 10) {
      return window.innerWidth - nr.right >= OUT_THICK + OUT_GAP ? n : null;
    }
  }
  return null;
}

const areas = new Map<HTMLElement, Area>();
const owner = new WeakMap<HTMLElement, HTMLElement>(); // thumb → its scroll area

const scrollsOn = (v: string) => v === "auto" || v === "scroll" || v === "overlay";

/** Which ways an element can scroll right now (it scrolls that way and has more content than room). */
export function scrollAxes(el: Element): { x: boolean; y: boolean } {
  if (!(el instanceof HTMLElement) || el === document.body || el === document.documentElement) return { x: false, y: false };
  const cs = getComputedStyle(el);
  return {
    x: scrollsOn(cs.overflowX) && el.scrollWidth - el.clientWidth > 1,
    y: scrollsOn(cs.overflowY) && el.scrollHeight - el.clientHeight > 1,
  };
}

/** The scroll area an element belongs to: itself if it's a thumb's area, else the nearest one that scrolls along `axis`. */
function areaFor(start: Element | null, axis: Axis): HTMLElement | null {
  // A pill counts as part of its scroll area.
  if (start instanceof HTMLElement && owner.has(start)) start = owner.get(start)!;
  for (let n: Element | null = start; n && n !== document.body; n = n.parentElement) {
    if (scrollAxes(n)[axis]) return n as HTMLElement;
  }
  return null;
}

/* ---------- Momentum scrolling ----------
 * Each wheel click or arrow press gives the area a push; it glides and eases to a stop.
 * Pushes that come quickly one after another stack up, so spinning the wheel faster
 * speeds up (acceleration), and a single click still moves a short, gentle distance.
 */

interface Glide { vx: number; vy: number; x: number; y: number; last: number; pushAt: number; streak: number; raf: number }
const glides = new WeakMap<HTMLElement, Glide>();
const GLIDE = 0.14;      // s: how long a push takes to fade (bigger = longer glide)
const MAX_SPEED = 6000;  // px/s

function push(el: HTMLElement, dx: number, dy: number) {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
    el.scrollLeft += dx;
    el.scrollTop += dy;
    return;
  }
  const now = performance.now();
  let g = glides.get(el);
  if (!g || !g.raf) {
    g = { vx: 0, vy: 0, x: el.scrollLeft, y: el.scrollTop, last: now, pushAt: 0, streak: 0, raf: 0 };
    glides.set(el, g);
  }
  // Quick pushes in a row build up: up to 2.8× after a few fast clicks.
  // Only for wheel clicks and key presses; a trackpad's stream of tiny nudges doesn't build up.
  const coarse = Math.abs(dx) + Math.abs(dy) >= 40;
  g.streak = coarse && now - g.pushAt < 140 ? Math.min(g.streak + 1, 6) : 0;
  g.pushAt = now;
  const boost = 1 + g.streak * 0.3;
  // A push of d px moves about d px on its own (distance = speed × GLIDE).
  const clamp = (v: number) => Math.max(-MAX_SPEED, Math.min(MAX_SPEED, v));
  // Reversing direction cancels the glide instead of fighting it.
  if (dx && Math.sign(dx) !== Math.sign(g.vx)) g.vx = 0;
  if (dy && Math.sign(dy) !== Math.sign(g.vy)) g.vy = 0;
  g.vx = clamp(g.vx + (dx * boost) / GLIDE);
  g.vy = clamp(g.vy + (dy * boost) / GLIDE);
  if (!g.raf) g.raf = requestAnimationFrame(glideFrame(el, g));
}

const glideFrame = (el: HTMLElement, g: Glide) => function frame(now: number) {
  // A frame's timestamp can be a hair earlier than the push that started it.
  const dt = Math.max(0, Math.min(0.05, (now - g.last) / 1000));
  g.last = now;
  // Someone else scrolled it meanwhile (a drag, the system): carry on from there.
  if (Math.abs(el.scrollLeft - g.x) > 2) g.x = el.scrollLeft;
  if (Math.abs(el.scrollTop - g.y) > 2) g.y = el.scrollTop;
  const maxX = el.scrollWidth - el.clientWidth;
  const maxY = el.scrollHeight - el.clientHeight;
  g.x += g.vx * dt;
  g.y += g.vy * dt;
  // Stop at an end only when heading into it.
  if ((g.x <= 0 && g.vx < 0) || (g.x >= maxX && g.vx > 0)) g.vx = 0;
  if ((g.y <= 0 && g.vy < 0) || (g.y >= maxY && g.vy > 0)) g.vy = 0;
  g.x = Math.max(0, Math.min(maxX, g.x));
  g.y = Math.max(0, Math.min(maxY, g.y));
  el.scrollLeft = g.x;
  el.scrollTop = g.y;
  const fade = Math.exp(-dt / GLIDE);
  g.vx *= fade;
  g.vy *= fade;
  const a = areas.get(el);
  if (a) place(a); // keep the pill in step with the content this same frame
  if (Math.abs(g.vx) < 8 && Math.abs(g.vy) < 8) { g.raf = 0; g.vx = g.vy = 0; return; }
  g.raf = requestAnimationFrame(frame);
};

/** Room left to scroll `el` in the direction of `delta`. */
function canMove(el: HTMLElement, axis: Axis, delta: number) {
  const pos = axis === "x" ? el.scrollLeft : el.scrollTop;
  const max = axis === "x" ? el.scrollWidth - el.clientWidth : el.scrollHeight - el.clientHeight;
  return delta < 0 ? pos > 1 : pos < max - 1;
}

/* ---------- The pills ---------- */

function makeThumb(area: HTMLElement, axis: Axis) {
  const t = document.createElement("div");
  t.className = `mc-scroll-thumb is-${axis}`;
  t.setAttribute("aria-hidden", "true");
  owner.set(t, area);
  // Drag the pill to scroll.
  t.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    t.setPointerCapture(e.pointerId);
    t.classList.add("is-dragging");
    const start = axis === "x" ? e.clientX : e.clientY;
    const from = axis === "x" ? area.scrollLeft : area.scrollTop;
    const view = axis === "x" ? area.clientWidth : area.clientHeight;
    const full = axis === "x" ? area.scrollWidth : area.scrollHeight;
    const track = view - INSET * 2;
    const len = Math.max(MIN_LEN, (track * view) / full);
    const perPx = (full - view) / Math.max(1, track - len);
    const move = (ev: PointerEvent) => {
      const d = ((axis === "x" ? ev.clientX : ev.clientY) - start) * perPx;
      if (axis === "x") area.scrollLeft = from + d;
      else area.scrollTop = from + d;
    };
    const up = () => {
      t.classList.remove("is-dragging");
      t.removeEventListener("pointermove", move);
      t.removeEventListener("pointerup", up);
      t.removeEventListener("pointercancel", up);
    };
    t.addEventListener("pointermove", move);
    t.addEventListener("pointerup", up);
    t.addEventListener("pointercancel", up);
  });
  return t;
}

function place(a: Area) {
  const { el } = a;
  const axes = scrollAxes(el);
  for (const axis of ["x", "y"] as Axis[]) {
    let t = a.thumbs[axis];
    if (!axes[axis]) {
      if (t) t.style.display = "none";
      continue;
    }
    const frame = axis === "y" ? a.frame : null;
    const anchor = frame ?? el;
    const parent = anchor.parentElement;
    if (!parent) continue;
    if (!t || !t.isConnected || t.parentElement !== parent) {
      t?.remove();
      t = a.thumbs[axis] = makeThumb(el, axis);
      parent.insertBefore(t, anchor.nextSibling);
    }
    t.classList.toggle("is-outside", !!frame);
    t.style.display = "";
    const box = t.offsetParent as HTMLElement | null;
    if (!box) { t.style.display = "none"; continue; }
    // The scroll area's visible box, in the coordinates the pill is positioned in.
    const r = el.getBoundingClientRect();
    const b = box.getBoundingClientRect();
    const left = r.left - b.left - box.clientLeft + box.scrollLeft + el.clientLeft;
    const top = r.top - b.top - box.clientTop + box.scrollTop + el.clientTop;
    const view = axis === "x" ? el.clientWidth : el.clientHeight;
    const full = axis === "x" ? el.scrollWidth : el.scrollHeight;
    const pos = axis === "x" ? el.scrollLeft : el.scrollTop;
    const track = view - INSET * 2;
    const len = Math.max(MIN_LEN, (track * view) / full);
    const at = INSET + (track - len) * Math.min(1, Math.max(0, pos / (full - view)));
    if (axis === "x") {
      t.style.left = `${left + at}px`;
      t.style.top = `${top + el.clientHeight - THICK - INSET}px`;
      t.style.width = `${len}px`;
      t.style.height = "";
    } else if (frame) {
      const f = frame.getBoundingClientRect();
      t.style.top = `${top + at}px`;
      t.style.left = `${f.right - b.left - box.clientLeft + box.scrollLeft + OUT_GAP}px`;
      t.style.height = `${len}px`;
      t.style.width = "";
    } else {
      t.style.top = `${top + at}px`;
      t.style.left = `${left + el.clientWidth - THICK - INSET}px`;
      t.style.height = `${len}px`;
      t.style.width = "";
    }
  }
}

function adopt(el: HTMLElement) {
  if (areas.has(el)) return;
  const resize = new ResizeObserver(() => schedule());
  resize.observe(el);
  areas.set(el, { el, thumbs: {}, resize, frame: findFrame(el) });
}

function drop(a: Area) {
  a.resize.disconnect();
  a.thumbs.x?.remove();
  a.thumbs.y?.remove();
  areas.delete(a.el);
}

/** Find every scroll area on the page (new ones get pills, gone ones lose theirs). */
function scan() {
  const all = document.body.querySelectorAll<HTMLElement>("*");
  for (const el of all) {
    if (el.classList.contains("mc-scroll-thumb") || el instanceof SVGElement) continue;
    if (el.scrollWidth - el.clientWidth <= 1 && el.scrollHeight - el.clientHeight <= 1) continue;
    const ax = scrollAxes(el);
    if (ax.x || ax.y) adopt(el);
  }
}

let frame = 0;
let rescan = false;
function schedule(withScan = false) {
  rescan ||= withScan;
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    if (rescan) {
      rescan = false;
      scan();
      // Layout may have changed (window size, sidebar): check again which pills go beside their panel.
      for (const a of areas.values()) {
        const frame = a.el.isConnected ? findFrame(a.el) : null;
        if (frame !== a.frame) { a.frame = frame; a.thumbs.y?.remove(); delete a.thumbs.y; }
      }
    }
    for (const a of [...areas.values()]) {
      if (!a.el.isConnected) drop(a);
      else place(a);
    }
  });
}

/* ---------- Mouse wheel and arrow keys ---------- */

let pointer: { x: number; y: number } | null = null;

const isTyping = (n: EventTarget | null) =>
  n instanceof Element && !!n.closest("input, textarea, select, [contenteditable=''], [contenteditable='true'], [role='slider'], [role='listbox'], [role='menu']");

/** The sideways row the wheel was last flipping through, and how far it's been spun past the row's end. */
let held: { area: Element; at: number; extra: number } | null = null;
/** A pause this long (between wheel clicks) at a row's end lets the page scroll. */
const HOLD_PAUSE_MS = 350;
/** ...or spinning this much further past the end (about six wheel clicks). */
const HOLD_EXTRA_PX = 600;

function onWheel(e: WheelEvent) {
  if (e.defaultPrevented || e.ctrlKey) return;
  // Already sideways (trackpad swipe, Shift+wheel): the system handles it.
  if (Math.abs(e.deltaX) >= Math.abs(e.deltaY) || e.shiftKey) return;
  const dy = e.deltaMode === 1 ? e.deltaY * 40 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
  // The nearest scroll area under the mouse that only goes sideways. Anything that also scrolls
  // up and down keeps the normal wheel.
  for (let n = e.target as Element | null; n && n !== document.body; n = n.parentElement) {
    const area = n instanceof HTMLElement && owner.has(n) ? owner.get(n)! : n;
    const ax = scrollAxes(area);
    if (ax.y) {
      // Over an up-and-down pill (which sits beside its scroll area, not in it): scroll that area.
      if (area !== n) { e.preventDefault(); (area as HTMLElement).scrollTop += dy; }
      return;
    }
    if (ax.x) {
      const now = performance.now();
      if (canMove(area as HTMLElement, "x", dy)) {
        held = { area, at: now, extra: 0 };
        e.preventDefault();
        push(area as HTMLElement, dy, 0);
        return;
      }
      // At an end. If you were just flipping through this row, the row holds on to the wheel a moment
      // longer (until you pause, or keep spinning a good while), so the page doesn't take off at once.
      if (held && held.area === area && now - held.at < HOLD_PAUSE_MS && held.extra < HOLD_EXTRA_PX) {
        held.at = now;
        held.extra += Math.abs(dy);
        e.preventDefault();
        return;
      }
      held = null;
      return; // the page scrolls
    }
    if (area !== n) return;
  }
}

function onKey(e: KeyboardEvent) {
  if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
  const dir = ({ ArrowLeft: ["x", -1], ArrowRight: ["x", 1], ArrowUp: ["y", -1], ArrowDown: ["y", 1] } as Record<string, [Axis, number]>)[e.key];
  if (!dir || isTyping(e.target)) return;
  const [axis, sign] = dir;
  // What you're pointing at comes first, then what has focus.
  // With a dialog open, only scroll inside it.
  const dialog = document.querySelector("[role='dialog'], dialog[open]");
  const inScope = (n: Element | null) => !!n && (!dialog || dialog.contains(n));
  const hovered = pointer ? document.elementFromPoint(pointer.x, pointer.y) : null;
  const area = (inScope(hovered) ? areaFor(hovered, axis) : null)
    ?? (inScope(document.activeElement) ? areaFor(document.activeElement, axis) : null)
    ?? (!dialog && axis === "y" ? document.querySelector<HTMLElement>(".shell-main") : null);
  if (!area) return;
  const step = axis === "x" ? Math.min(area.clientWidth * 0.8, 160) : 80;
  if (!canMove(area, axis, sign)) return;
  e.preventDefault();
  push(area, axis === "x" ? step * sign : 0, axis === "y" ? step * sign : 0);
}

/** Turn it all on. Returns a function that turns it off. */
export function installScrollbars() {
  document.documentElement.dataset.mcScrollbars = "on";
  const mo = new MutationObserver((records) => {
    const ours = records.every((r) => r.type === "childList" && [...r.addedNodes, ...r.removedNodes].every((n) => n instanceof HTMLElement && n.classList.contains("mc-scroll-thumb")));
    if (!ours) schedule(true);
  });
  mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "hidden", "open"] });
  const onScroll = (e: Event) => {
    const t = e.target;
    if (t instanceof HTMLElement && !areas.has(t)) {
      const ax = scrollAxes(t);
      if (ax.x || ax.y) adopt(t);
    }
    schedule();
  };
  const onMove = (e: PointerEvent) => { pointer = { x: e.clientX, y: e.clientY }; };
  const onLeave = () => { pointer = null; };
  const onLayout = () => schedule(true);
  document.addEventListener("scroll", onScroll, true);
  document.addEventListener("load", onLayout, true); // images finishing change sizes
  window.addEventListener("resize", onLayout);
  window.addEventListener("wheel", onWheel, { passive: false });
  window.addEventListener("keydown", onKey);
  window.addEventListener("pointermove", onMove, { passive: true });
  document.documentElement.addEventListener("pointerleave", onLeave);
  schedule(true);
  return () => {
    mo.disconnect();
    document.removeEventListener("scroll", onScroll, true);
    document.removeEventListener("load", onLayout, true);
    window.removeEventListener("resize", onLayout);
    window.removeEventListener("wheel", onWheel);
    window.removeEventListener("keydown", onKey);
    window.removeEventListener("pointermove", onMove);
    document.documentElement.removeEventListener("pointerleave", onLeave);
    for (const a of [...areas.values()]) drop(a);
    delete document.documentElement.dataset.mcScrollbars;
  };
}
