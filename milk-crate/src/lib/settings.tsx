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
}
const SettingsContext = createContext<Settings | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = usePersistentState<"dark" | "light">("mc.theme", "dark");
  const [matchAlbum, setMatchAlbum] = usePersistentState("mc.matchAlbumColors", true);
  const [glass, setGlass] = usePersistentState("mc.glass", true);
  const [seeThrough, setSeeThrough] = usePersistentState("mc.seeThrough", true);
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
    <SettingsContext.Provider value={{ theme, setTheme, matchAlbum, setMatchAlbum, glass, setGlass, seeThrough, setSeeThrough }}>
      {children}
    </SettingsContext.Provider>
  );
}

export function useSettings() {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error("useSettings must be used inside <SettingsProvider>");
  return ctx;
}
