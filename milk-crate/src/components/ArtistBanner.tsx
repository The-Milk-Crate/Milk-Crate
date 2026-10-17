import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import type { Artist } from "../lib/types";
import { LIGHT_INK, cssUrl, inkOn, nameStyle, useNameFamily } from "../lib/artistPage";

/**
 * The banner at the top of an artist's page, with their name (or logo) set
 * inside it toward the bottom. Artists can give a wide and a vertical banner:
 * the wide one shows whenever the banner is wider than it is tall, the
 * vertical one whenever it's taller, always as the artist set them (whatever
 * shape the photos themselves are), cross-fading as the window is resized.
 * With only one of them, it shows everywhere.
 *
 * `fill` makes the banner fill its parent (used for the previews in the designer).
 */
export function ArtistBanner({ artist, fill = false, headingLevel = 1 }: { artist: Artist; fill?: boolean; headingLevel?: 1 | 2 }) {
  const { page, accent } = artist;
  const box = useRef<HTMLDivElement>(null);
  const [boxRatio, setBoxRatio] = useState(16 / 9);
  const family = useNameFamily(page);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => {
      const { width, height } = e.contentRect;
      if (width && height) setBoxRatio(width / height);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const wide = page.banner;
  const tall = page.bannerTall;
  // The slot decides, not the photo: tall shapes get the vertical banner, wide shapes the wide one.
  const showTall = !!tall && (!wide || boxRatio < 1);
  const hasPhoto = !!(wide || tall);
  const autoInk = hasPhoto ? LIGHT_INK : inkOn(accent);
  const showLogo = page.nameMode === "logo" && !!page.logo;
  const Heading = headingLevel === 1 ? "h1" : "h2";

  return (
    <div ref={box} className={`artist-banner${hasPhoto ? "" : " plain"}${fill ? " fill" : ""}`} style={{ background: accent, color: autoInk }}>
      {wide && (
        <img className={`artist-banner-img${showTall ? "" : " on"}`} src={wide} alt="" aria-hidden="true" />
      )}
      {tall && (
        <img className={`artist-banner-img${showTall ? " on" : ""}`} src={tall} alt="" aria-hidden="true" />
      )}
      {hasPhoto && !page.noShade && <div className="artist-banner-shade" aria-hidden="true" />}
      <div className="artist-banner-text">
        <Heading className="artist-name">
          {showLogo ? <img className="artist-logo" src={page.logo} alt={artist.name} /> : <FitLine style={nameStyle(page, family, autoInk)}>{artist.name}</FitLine>}
        </Heading>
        <span className="catalog artist-banner-meta">
          {[artist.place, artist.genres.join(", ")].filter(Boolean).join(" · ")}
        </span>
      </div>
    </div>
  );
}

/**
 * One line of text, centered, at the style's font size — or smaller, just
 * enough to fit the available width. Re-fits when the space changes size or a
 * font finishes loading.
 */
function FitLine({ style, children }: { style: CSSProperties; children: string }) {
  const wrap = useRef<HTMLSpanElement>(null);
  const probe = useRef<HTMLSpanElement>(null);
  const [size, setSize] = useState<number | null>(null);
  const key = JSON.stringify(style) + children;

  useLayoutEffect(() => {
    const fit = () => {
      const w = wrap.current, p = probe.current;
      if (!w || !p) return;
      const max = parseFloat(getComputedStyle(p).fontSize);
      const natural = p.getBoundingClientRect().width;
      const room = w.clientWidth;
      if (!natural || !room) return;
      setSize(Math.max(8, Math.min(max, Math.floor(max * (room / natural) * 0.98 * 10) / 10)));
    };
    fit();
    const ro = new ResizeObserver(fit);
    if (wrap.current) ro.observe(wrap.current);
    document.fonts.addEventListener("loadingdone", fit);
    document.fonts.ready.then(fit);
    return () => {
      ro.disconnect();
      document.fonts.removeEventListener("loadingdone", fit);
    };
  }, [key]);

  return (
    <span ref={wrap} className="fit-line">
      {/* Invisible copy at full size, used only to measure. */}
      <span ref={probe} className="fit-line-probe" style={style} aria-hidden="true">{children}</span>
      <span style={{ ...style, ...(size ? { fontSize: `${size}px` } : null), whiteSpace: "nowrap" }}>{children}</span>
    </span>
  );
}

/** A small square for lists: the artist's banner, or their initials on their color. */
export function ArtistThumb({ artist, size = 48 }: { artist: Artist; size?: number }) {
  const photo = artist.page.bannerTall ?? artist.page.banner;
  const words = artist.name.split(/\s+/);
  const initials = (words.length > 2 && /^(the|a|an)$/i.test(words[0]) ? words.slice(1) : words)
    .filter((w) => /[a-z0-9]/i.test(w[0] ?? "")).slice(0, 2).map((w) => w[0].toUpperCase()).join("") || "♪";
  return (
    <span className="artist-thumb" aria-hidden="true"
      style={{ width: size, height: size, fontSize: size * 0.36, background: photo ? `${cssUrl(photo)} center / cover` : artist.accent, color: inkOn(artist.accent) }}>
      {!photo && initials}
    </span>
  );
}
