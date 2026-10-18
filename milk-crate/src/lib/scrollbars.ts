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
}

const THICK = 10;  // px, across the bar
const INSET = 4;   // px from the scroll area's edges
const MIN_LEN = 36; // px, shortest the pill gets

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

/* ---------- Smooth scrolling that adds up (several wheel clicks in a row go further) ---------- */

const pending = new WeakMap<HTMLElement, { x: number; y: number; at: number }>();

function scrollByAdding(el: HTMLElement, dx: number, dy: number) {
  const now = performance.now();
  const p = pending.get(el);
  const fresh = !p || now - p.at > 250;
  const maxX = el.scrollWidth - el.clientWidth;
  const maxY = el.scrollHeight - el.clientHeight;
  const x = Math.max(0, Math.min(maxX, (fresh ? el.scrollLeft : p.x) + dx));
  const y = Math.max(0, Math.min(maxY, (fresh ? el.scrollTop : p.y) + dy));
  pending.set(el, { x, y, at: now });
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  el.scrollTo({ left: x, top: y, behavior: reduce ? "auto" : "smooth" });
}

/** Room left to scroll `el` in the direction of `delta`. */
function canMove(el: HTMLElement, axis: Axis, delta: number) {
  const pos = axis === "x" ? el.scrollLeft : el.scrollTop;
  const max = axis === "x" ? el.scrollWidth - el.clientWidth : el.scrollHeight - el.clientHeight;
  // A few px of slack: rows that snap to their cards stop a little short of their very ends.
  return delta < 0 ? pos > 8 : pos < max - 8;
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
    const parent = el.parentElement;
    if (!parent) continue;
    if (!t || !t.isConnected || t.parentElement !== parent) {
      t?.remove();
      t = a.thumbs[axis] = makeThumb(el, axis);
      parent.insertBefore(t, el.nextSibling);
    }
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
  areas.set(el, { el, thumbs: {}, resize });
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
    if (rescan) { rescan = false; scan(); }
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
      // At either end, let the wheel move the page instead.
      if (!canMove(area as HTMLElement, "x", dy)) return;
      e.preventDefault();
      scrollByAdding(area as HTMLElement, dy, 0);
      return;
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
  scrollByAdding(area, axis === "x" ? step * sign : 0, axis === "y" ? step * sign : 0);
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
