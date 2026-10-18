import { useEffect, useRef } from "react";

/**
 * Keeps something fresh while the app is open: runs `refresh` every `everyMs` while the window is
 * showing, and when you come back to the window (at most once every `minGapMs`).
 */
export function useLiveRefresh(refresh: () => void, everyMs = 2 * 60_000, minGapMs = 20_000) {
  const fn = useRef(refresh);
  fn.current = refresh;
  useEffect(() => {
    let last = Date.now();
    const run = () => {
      if (document.visibilityState === "hidden" || Date.now() - last < minGapMs) return;
      last = Date.now();
      fn.current();
    };
    const timer = window.setInterval(run, everyMs);
    window.addEventListener("focus", run);
    document.addEventListener("visibilitychange", run);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", run); document.removeEventListener("visibilitychange", run); };
  }, [everyMs, minGapMs]);
}
