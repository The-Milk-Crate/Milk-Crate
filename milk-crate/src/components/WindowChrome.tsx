import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { isDesktop } from "../lib/localFiles";

/**
 * The window has no title bar of its own (it's see-through, part of the app):
 * - Windows: minimize / maximize / close sit in the main panel's top-right corner (drawn here).
 * - Mac: the system's red, yellow and green buttons float in the top-left corner (macOS draws them).
 * Either way the top edge of the window drags it, and double-clicking there maximizes.
 */
export const platform = (): "windows" | "mac" | "other" =>
  !isDesktop() ? "other" : /Mac/i.test(navigator.userAgent) ? "mac" : /Windows/i.test(navigator.userAgent) ? "windows" : "other";

/** How far down from the window's top edge counts as the drag area (px). */
const DRAG_ZONE = 52;
const INTERACTIVE = "button, a, input, textarea, select, label, summary, [role='button'], [role='slider'], [role='switch'], [role='tab'], [contenteditable='true'], .mc-scroll-thumb";

export function WindowChrome() {
  const os = platform();
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (os === "other") return;
    document.documentElement.dataset.platform = os;
    let unlisten: (() => void) | undefined;
    let live = true;
    void import("@tauri-apps/api/window").then(async ({ getCurrentWindow }) => {
      const win = getCurrentWindow();
      const sync = () => void win.isMaximized().then((m) => live && setMaximized(m)).catch(() => {});
      sync();
      const off = await win.onResized(sync);
      if (live) unlisten = off; else off();
    });
    // Drag the window by its top edge (not by buttons, fields or the like up there).
    const onDown = (e: MouseEvent) => {
      if (e.button !== 0 || e.clientY > DRAG_ZONE) return;
      const t = e.target as Element | null;
      if (!t || t.closest(INTERACTIVE) || t.closest(".eq-pop, .modal, [role='dialog']")) return;
      void import("@tauri-apps/api/window").then(({ getCurrentWindow }) => {
        const win = getCurrentWindow();
        if (e.detail === 2) void win.toggleMaximize();
        else void win.startDragging();
      });
    };
    window.addEventListener("mousedown", onDown);
    return () => { live = false; unlisten?.(); window.removeEventListener("mousedown", onDown); };
  }, [os]);

  if (os !== "windows") return null;
  const act = (what: "minimize" | "toggleMaximize" | "close") => () =>
    void import("@tauri-apps/api/window").then(({ getCurrentWindow }) => getCurrentWindow()[what]());
  return createPortal(
    <div className="win-controls" role="group" aria-label="Window">
      <button type="button" className="win-btn" aria-label="Minimize" title="Minimize" onClick={act("minimize")}>
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M1 6h10" stroke="currentColor" strokeWidth="1.2" /></svg>
      </button>
      <button type="button" className="win-btn" aria-label={maximized ? "Restore" : "Maximize"} title={maximized ? "Restore" : "Maximize"} onClick={act("toggleMaximize")}>
        {maximized ? (
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><rect x="1.5" y="3.5" width="7" height="7" rx="1.2" fill="none" stroke="currentColor" strokeWidth="1.2" /><path d="M3.5 3.5V2.7c0-.7.5-1.2 1.2-1.2h4.6c.7 0 1.2.5 1.2 1.2v4.6c0 .7-.5 1.2-1.2 1.2h-.8" fill="none" stroke="currentColor" strokeWidth="1.2" /></svg>
        ) : (
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><rect x="1.5" y="1.5" width="9" height="9" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.2" /></svg>
        )}
      </button>
      <button type="button" className="win-btn is-close" aria-label="Close" title="Close" onClick={act("close")}>
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.2" /></svg>
      </button>
    </div>,
    document.body,
  );
}
