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
  /** Experimental: fine grain on the glass that refracts the album colors (src/lib/frost.ts). Off by default. */
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
  const [frostTexture, setFrostTexture] = usePersistentState("mc.frostGrain", false);
  useEffect(() => applyGlassTints(theme, transparency), [theme, transparency]);
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

/* ---------- Frosted glass: tint strength ---------- */

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

