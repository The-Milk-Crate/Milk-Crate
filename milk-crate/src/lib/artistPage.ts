/**
 * Artist page design: the fonts artists can letter their name in, how a
 * saved design turns into styles, and checks on designs loaded from the
 * server (every listener sees them, so only safe values get through).
 */
import { useEffect, useState, type CSSProperties } from "react";
import { SUPABASE_URL } from "../config";
import { contrast } from "./accent";
import type { ArtistPage } from "./types";

// Name fonts ship with the app (Latin letters, regular weight), so pages look right offline.
import "@fontsource/bebas-neue/latin-400.css";
import "@fontsource/fraunces/latin-400.css";
import "@fontsource/fraunces/latin-700.css";
import "@fontsource/abril-fatface/latin-400.css";
import "@fontsource/unifrakturmaguntia/latin-400.css";
import "@fontsource/permanent-marker/latin-400.css";
import "@fontsource/rock-salt/latin-400.css";
import "@fontsource/special-elite/latin-400.css";
import "@fontsource/pacifico/latin-400.css";
import "@fontsource/monoton/latin-400.css";
import "@fontsource/rubik-mono-one/latin-400.css";
import "@fontsource/righteous/latin-400.css";
import "@fontsource/shrikhand/latin-400.css";

export interface NameFont { id: string; label: string; family: string }

export const NAME_FONTS: NameFont[] = [
  { id: "milkcrate", label: "Milk Crate", family: '"Archivo Black", sans-serif' },
  { id: "clean", label: "Clean", family: '"Archivo Variable", Archivo, sans-serif' },
  { id: "poster", label: "Poster", family: '"Bebas Neue", sans-serif' },
  { id: "softserif", label: "Soft serif", family: "Fraunces, Georgia, serif" },
  { id: "classic", label: "Classic", family: 'Georgia, "Times New Roman", serif' },
  { id: "fatface", label: "Fat face", family: '"Abril Fatface", Georgia, serif' },
  { id: "blackletter", label: "Blackletter", family: "UnifrakturMaguntia, serif" },
  { id: "marker", label: "Marker", family: '"Permanent Marker", cursive' },
  { id: "scrawl", label: "Scrawl", family: '"Rock Salt", cursive' },
  { id: "typewriter", label: "Typewriter", family: '"Special Elite", monospace' },
  { id: "mono", label: "Mono", family: '"IBM Plex Mono", monospace' },
  { id: "script", label: "Script", family: "Pacifico, cursive" },
  { id: "neon", label: "Neon", family: "Monoton, sans-serif" },
  { id: "wide", label: "Wide", family: '"Rubik Mono One", sans-serif' },
  { id: "retro", label: "Retro", family: "Righteous, sans-serif" },
  { id: "chunky", label: "Chunky", family: "Shrikhand, serif" },
];
const FONT_BY_ID = Object.fromEntries(NAME_FONTS.map((f) => [f.id, f]));

/** Largest name size, relative to the banner (container units). Long names shrink further to stay on one line. */
export const NAME_SIZES = { m: "clamp(22px, 7cqi, 56px)", l: "clamp(28px, 10cqi, 88px)", xl: "clamp(34px, 14cqi, 132px)" } as const;

/** Dark and light inks from the design system; the page picks whichever reads better on the artist's color. */
const DARK_INK = "#13110f";
export const LIGHT_INK = "#f3ede3";
export const inkOn = (bg: string) => (contrast(bg, DARK_INK) >= contrast(bg, LIGHT_INK) ? DARK_INK : LIGHT_INK);

/* ---------- checks on designs from the server ---------- */

const PUBLIC_FILES = `${SUPABASE_URL}/storage/v1/object/public/`;

export const safeColor = (v: unknown) => (typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v) ? v : undefined);
/** Only files stored on the Milk Crate server, with no characters that could break out of a CSS url(). */
const safeUrl = (v: unknown) => (typeof v === "string" && v.startsWith(PUBLIC_FILES) && !/["'()\\\s<>]/.test(v) ? v : undefined);
const isOn = (v: unknown) => v === true || undefined;

export function sanitizePage(raw: unknown): ArtistPage {
  if (!raw || typeof raw !== "object") return {};
  const r = raw as Record<string, unknown>;
  const page: ArtistPage = {
    banner: safeUrl(r.banner),
    bannerTall: safeUrl(r.bannerTall),
    noShade: isOn(r.noShade),
    logo: safeUrl(r.logo),
    nameMode: r.nameMode === "logo" ? "logo" : undefined,
    font: typeof r.font === "string" && (r.font === "custom" || r.font in FONT_BY_ID) ? r.font : undefined,
    fontUrl: safeUrl(r.fontUrl),
    fontName: typeof r.fontName === "string" ? r.fontName.slice(0, 80) : undefined,
    nameColor: safeColor(r.nameColor),
    bold: isOn(r.bold),
    italic: isOn(r.italic),
    caps: isOn(r.caps),
    spacing: typeof r.spacing === "number" && Number.isFinite(r.spacing) ? Math.min(0.3, Math.max(-0.05, r.spacing)) : undefined,
    size: r.size === "m" || r.size === "xl" ? r.size : undefined,
  };
  // Drop empty keys so saved JSON stays small.
  return Object.fromEntries(Object.entries(page).filter(([, v]) => v !== undefined)) as ArtistPage;
}

/** The path of a server file inside the "profiles" bucket, for deleting replaced files. */
export const profilesPath = (url?: string) =>
  url?.startsWith(`${PUBLIC_FILES}profiles/`) ? decodeURIComponent(url.slice(`${PUBLIC_FILES}profiles/`.length)) : null;
export const isServerFile = (url?: string) => !!url?.startsWith(PUBLIC_FILES);

/* ---------- uploaded fonts ---------- */

const loaded = new Map<string, Promise<string | null>>();

/** Registers an uploaded font file and resolves to its CSS family name (null if it can't be read). */
function loadFont(url: string): Promise<string | null> {
  let p = loaded.get(url);
  if (!p) {
    const family = `mc-font-${loaded.size + 1}`;
    p = new FontFace(family, `url(${JSON.stringify(url)})`)
      .load()
      .then((face) => {
        document.fonts.add(face);
        return family;
      })
      .catch(() => null);
    loaded.set(url, p);
  }
  return p;
}

/** The CSS font-family for a page's name, loading an uploaded font when there is one. */
export function useNameFamily(page: ArtistPage): string {
  const builtIn = (FONT_BY_ID[page.font ?? ""] ?? NAME_FONTS[0]).family;
  const url = page.font === "custom" ? page.fontUrl : undefined;
  const [custom, setCustom] = useState<{ url: string; family: string | null } | null>(null);
  useEffect(() => {
    if (!url) return;
    let live = true;
    loadFont(url).then((family) => live && setCustom({ url, family }));
    return () => {
      live = false;
    };
  }, [url]);
  if (url && custom?.url === url && custom.family) return `"${custom.family}", ${NAME_FONTS[0].family}`;
  return builtIn;
}

/** Inline styles for the lettered name. `family` comes from useNameFamily; `autoInk` is used when no color is chosen. */
export function nameStyle(page: ArtistPage, family: string, autoInk: string): CSSProperties {
  return {
    fontFamily: family,
    color: page.nameColor ?? autoInk,
    fontSize: NAME_SIZES[page.size ?? "l"],
    fontWeight: page.bold ? 800 : page.font === "clean" ? 500 : 400,
    fontStyle: page.italic ? "italic" : "normal",
    textTransform: page.caps ? "uppercase" : "none",
    letterSpacing: `${page.spacing ?? 0}em`,
    lineHeight: 1.1,
  };
}

/** CSS url() for a photo (server or local preview). */
export const cssUrl = (u: string) => `url(${JSON.stringify(u)})`;
