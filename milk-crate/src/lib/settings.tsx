/** App settings, saved on this computer. */
import { createContext, useContext, useEffect, type ReactNode } from "react";
import { usePersistentState } from "./storage";
import { isDesktop } from "./localFiles";

interface Settings {
  theme: "dark" | "light";
  setTheme: (t: "dark" | "light") => void;
  /** Accent color follows the album that's playing. */
  matchAlbum: boolean;
  setMatchAlbum: (on: boolean) => void;
  /** Frosted-glass surfaces, with the playing album's colors swirling behind them. */
  glass: boolean;
  setGlass: (on: boolean) => void;
  /** Desktop app: the window itself is frosted and see-through (Windows acrylic). */
  seeThrough: boolean;
  setSeeThrough: (on: boolean) => void;
  /** Your accent color (hex), or null for Milk Crate lavender. */
  accentColor: string | null;
  setAccentColor: (hex: string | null) => void;
  /** How see-through the frosted glass is, 0 (nearly solid) to 100 (clearest). 50 is the default. */
  transparency: number;
  setTransparency: (v: number) => void;
  /** The fine, subtle texture of real frosted glass on the glass surfaces. */
  frostTexture: boolean;
  setFrostTexture: (on: boolean) => void;
}

export const DEFAULT_TRANSPARENCY = 50;
const SettingsContext = createContext<Settings | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = usePersistentState<"dark" | "light">("mc.theme", "dark");
  const [matchAlbum, setMatchAlbum] = usePersistentState("mc.matchAlbumColors", true);
  const [glass, setGlass] = usePersistentState("mc.glass", true);
  const [seeThrough, setSeeThrough] = usePersistentState("mc.seeThrough", true);
  const [accentColor, setAccentColor] = usePersistentState<string | null>("mc.accentColor", null);
  const [transparency, setTransparency] = usePersistentState("mc.glassTransparency", DEFAULT_TRANSPARENCY);
  const [frostTexture, setFrostTexture] = usePersistentState("mc.frostTexture", true);
  useEffect(() => applyGlassTints(theme, transparency), [theme, transparency]);
  useEffect(() => applyGrain(frostTexture, theme), [frostTexture, theme]);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  useEffect(() => {
    document.documentElement.dataset.glass = glass ? "on" : "off";
  }, [glass]);
  // Frosted window (desktop app only). The page lets the desktop show through only once the effect is on.
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.seeThrough = "false";
    if (!isDesktop()) return;
    let live = true;
    import("@tauri-apps/api/window").then(async ({ getCurrentWindow, Effect, EffectState }) => {
      const win = getCurrentWindow();
      const mac = /Mac/i.test(navigator.userAgent);
      try {
        if (glass && seeThrough) {
          await win.setEffects(
            mac
              ? // Apple's Liquid Glass on macOS 26+, the classic frosted material on older versions.
                { effects: [Effect.LiquidGlassRegular, Effect.UnderWindowBackground], state: EffectState.Active }
              : { effects: [Effect.Acrylic, Effect.Mica], color: [19, 17, 15, 110] },
          );
          if (live) root.dataset.seeThrough = "true";
        } else {
          await win.clearEffects();
        }
      } catch {
        /* effects not supported on this system: keep the solid background */
      }
    });
    return () => {
      live = false;
    };
  }, [glass, seeThrough]);
  return (
    <SettingsContext.Provider value={{ theme, setTheme, matchAlbum, setMatchAlbum, glass, setGlass, seeThrough, setSeeThrough, accentColor, setAccentColor, transparency, setTransparency, frostTexture, setFrostTexture }}>
      {children}
    </SettingsContext.Provider>
  );
}

export function useSettings() {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error("useSettings must be used inside <SettingsProvider>");
  return ctx;
}

/* ---------- Frosted glass: tint strength and texture ---------- */

/** Glass tint opacities at the default transparency, per theme. */
const TINTS = {
  dark: { veil: 0.4, bar: 0.68, main: 0.56, panel: 0.68, mainSeeThrough: 0.5 },
  light: { veil: 0.38, bar: 0.66, main: 0.55, panel: 0.6, mainSeeThrough: 0.45 },
} as const;

/**
 * Transparency 0–100 → a multiplier on the tints: 50 is ×1, 0 is ×1.4 (frostier),
 * 100 is ×0.84 (clearer). The clear end stops where text still meets WCAG AA
 * contrast over bright album colors.
 */
export function tintScale(transparency: number) {
  const t = Math.max(0, Math.min(100, transparency));
  return t <= 50 ? 1 + ((50 - t) / 50) * 0.4 : 1 - ((t - 50) / 50) * 0.16;
}

function applyGlassTints(theme: "dark" | "light", transparency: number) {
  // Light glass lets bright colors through more, so it doesn't clear quite as far.
  const k = theme === "light" ? Math.max(0.92, tintScale(transparency)) : tintScale(transparency);
  const root = document.documentElement.style;
  for (const [name, a] of Object.entries(TINTS[theme])) root.setProperty(`--a-${name}`, String(Math.min(0.97, +(a * k).toFixed(3))));
}

/**
 * Real frosted glass has a fine, dense speckle: tiny soft flecks a little lighter
 * and a little darker than the glass. This builds it as a tiling SVG noise image
 * (set as --grain over the glass surfaces). Two noise layers, one for each tone,
 * each keep only their side of the middle, so the glass isn't greyed overall.
 */
export function grainImage(theme: "dark" | "light" = "dark") {
  // On light glass, dark flecks read as dust, so they're a little fainter there.
  const [light, dark] = theme === "light" ? [0.32, 0.34] : [0.36, 0.38];
  const layer = (id: string, seed: number, rgb: number, a: number, invert: boolean) =>
    `<filter id='${id}' x='0' y='0' width='100%' height='100%' color-interpolation-filters='sRGB'>` +
    `<feTurbulence type='fractalNoise' baseFrequency='1.45' numOctaves='2' seed='${seed}' stitchTiles='stitch'/>` +
    `<feGaussianBlur stdDeviation='0.4' edgeMode='wrap'/>` +
    `<feColorMatrix values='0 0 0 0 ${rgb}  0 0 0 0 ${rgb}  0 0 0 0 ${rgb}  ${invert ? -a : a} 0 0 0 ${(invert ? a : -a) / 2}'/>` +
    `</filter><rect width='100%' height='100%' filter='url(#${id})'/>`;
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='256' height='256'>${layer("l", 7, 1, light, false)}${layer("d", 19, 0, dark, true)}</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

function applyGrain(on: boolean, theme: "dark" | "light") {
  document.documentElement.style.setProperty("--grain", on ? grainImage(theme) : "none");
}
