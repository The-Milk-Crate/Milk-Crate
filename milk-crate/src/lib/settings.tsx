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
  /** How see-through the frosted glass is, 0 (nearly solid) to 100 (clearest, the default). */
  transparency: number;
  setTransparency: (v: number) => void;
  /** Experimental: fine grain on the glass that refracts the album colors (src/lib/frost.ts). On by default. */
  frostTexture: boolean;
  setFrostTexture: (on: boolean) => void;
}

/** Clearest glass by default (still passes WCAG AA; see tintScale). */
export const DEFAULT_TRANSPARENCY = 100;
const SettingsContext = createContext<Settings | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = usePersistentState<"dark" | "light">("mc.theme", "dark");
  const [matchAlbum, setMatchAlbum] = usePersistentState("mc.matchAlbumColors", true);
  const [glass, setGlass] = usePersistentState("mc.glass", true);
  const [seeThrough, setSeeThrough] = usePersistentState("mc.seeThrough", true);
  const [accentColor, setAccentColor] = usePersistentState<string | null>("mc.accentColor", null);
  const [transparency, setTransparency] = usePersistentState("mc.glassClarity", DEFAULT_TRANSPARENCY);
  const [frostTexture, setFrostTexture] = usePersistentState("mc.frostGrainOn", true);
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
  // Windows: a title bar that matches the app (in every mode), not the system accent color.
  useEffect(() => {
    if (!isDesktop() || /Mac/i.test(navigator.userAgent)) return;
    void colorTitleBar(theme);
  }, [theme]);
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
  // Light glass is lighter-handed than dark, so the colors come through and it's easier on the eyes.
  light: { veil: 0.26, bar: 0.5, main: 0.4, panel: 0.46, mainSeeThrough: 0.34 },
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
  // Light glass stays more see-through than dark even fully frosted (at most ×1.25), and doesn't clear
  // quite as far (bright colors come through light glass more).
  const k = theme === "light" ? Math.min(1.25, Math.max(0.92, tintScale(transparency))) : tintScale(transparency);
  const root = document.documentElement.style;
  for (const [name, a] of Object.entries(TINTS[theme])) root.setProperty(`--a-${name}`, String(Math.min(0.97, +(a * k).toFixed(3))));
}

/** COLORREF (0x00BBGGRR) from "#rrggbb". */
const colorRef = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  return ((n & 0xff) << 16) | (n & 0xff00) | ((n >> 16) & 0xff);
};
const SYSTEM_DEFAULT = 0xffffffff;

/**
 * Windows paints the title bar in the system accent color (often bright blue)
 * when "Show accent color on title bars" is on. Paint it the app's own ground
 * and ink instead; `null` gives it back to the system.
 */
async function colorTitleBar(theme: "dark" | "light" | null) {
  const { invoke } = await import("@tauri-apps/api/core");
  const [ground, ink] = theme === "light" ? ["#f3eee5", "#1b1714"] : ["#13110f", "#f3ede3"];
  const args = theme
    ? { caption: colorRef(ground), text: colorRef(ink), border: colorRef(ground) }
    : { caption: SYSTEM_DEFAULT, text: SYSTEM_DEFAULT, border: SYSTEM_DEFAULT };
  await invoke("set_title_bar_colors", args).catch(() => {});
}
