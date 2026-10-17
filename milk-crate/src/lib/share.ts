/**
 * Links to albums, artists and scenes.
 *
 * - Share links (what Share copies) point at the share page on the web
 *   (SHARE_PAGE + ?album=<id>, ?artist=<id>, ?scene=NC/Durham, ?scene=CA/ON/Toronto),
 *   so they're clickable in texts, Instagram and email. The page shows what it
 *   is and opens it in the app.
 * - App links: milkcrate://album/<id>, milkcrate://artist/<id>,
 *   milkcrate://scene/<state>/<town> (US) or milkcrate://scene/<country>/<province>/<town>.
 *   Opening one starts Milk Crate (or brings it forward) on that page. Registered
 *   with the system by the desktop app's installer (tauri-plugin-deep-link).
 */
import type { Route } from "../App";
import { isDesktop } from "./localFiles";
import { REGION_NAMES, type Country } from "./geo";
import { SHARE_PAGE } from "../config";

export const SCHEME = "milkcrate";

type LinkTarget = { kind: "album"; id: string } | { kind: "artist"; id: string } | { kind: "scene"; name: string; state: string; country?: Country };

/** "NC/Durham" or "CA/ON/Toronto". */
const scenePath = (r: { name: string; state: string; country?: Country }) =>
  [...(r.country && r.country !== "US" ? [r.country] : []), r.state, r.name].map(encodeURIComponent).join("/");

/** The link to share: a web page that opens it in Milk Crate. */
export function linkFor(r: LinkTarget) {
  if (r.kind === "scene") return `${SHARE_PAGE}?scene=${scenePath(r)}`;
  return `${SHARE_PAGE}?${r.kind}=${encodeURIComponent(r.id)}`;
}

/** The milkcrate:// link that opens it in the app directly. */
export function appLinkFor(r: LinkTarget) {
  if (r.kind === "scene") {
    const where = r.country && r.country !== "US" ? `${r.country}/${encodeURIComponent(r.state)}` : encodeURIComponent(r.state);
    return `${SCHEME}://scene/${where}/${encodeURIComponent(r.name)}`;
  }
  return `${SCHEME}://${r.kind}/${encodeURIComponent(r.id)}`;
}

/** The page a link points to (a share page link or a milkcrate:// link), or null if it isn't one. */
export function routeFromLink(url: string): Route | null {
  const text = url.trim();
  if (text.startsWith(SHARE_PAGE)) {
    try {
      const q = new URL(text).searchParams;
      for (const kind of ["album", "artist", "scene"] as const) {
        const v = q.get(kind);
        if (v) return routeFromLink(`${SCHEME}://${kind}/${kind === "scene" ? v.split("/").map(encodeURIComponent).join("/") : encodeURIComponent(v)}`);
      }
    } catch {
      return null;
    }
    return null;
  }
  const m = text.match(/^milkcrate:\/\/([a-z]+)\/([^?#]*)/i);
  if (!m) return null;
  const parts = m[2].split("/").filter(Boolean).map(decodeURIComponent);
  const kind = m[1].toLowerCase();
  if (kind === "album" && parts[0]) return { name: "album", releaseId: parts[0] };
  if (kind === "artist" && parts[0]) return { name: "artist", artistId: parts[0] };
  if (kind === "scene" && parts.length >= 3) {
    const country = parts[0].toUpperCase();
    if ((country === "CA" || country === "AU") && REGION_NAMES[country][parts[1].toUpperCase()])
      return { name: "scenes", explore: { country, state: parts[1].toUpperCase(), name: parts.slice(2).join("/") } };
  }
  if (kind === "scene" && parts.length >= 2) return { name: "scenes", explore: { state: parts[0].toUpperCase(), name: parts.slice(1).join("/") } };
  return null;
}

/** Calls `open` with the page for every share link Milk Crate is opened with (at launch and while running). */
export async function listenForLinks(open: (r: Route) => void): Promise<() => void> {
  if (!isDesktop()) return () => {};
  try {
    const { getCurrent, onOpenUrl } = await import("@tauri-apps/plugin-deep-link");
    const handle = (urls: string[] | null) => {
      const r = urls?.map(routeFromLink).find(Boolean);
      if (r) open(r);
    };
    handle(await getCurrent().catch(() => null));
    return await onOpenUrl(handle);
  } catch {
    return () => {};
  }
}

export async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Older webviews: fall back to a hidden text box.
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  }
}
