/** Full-screen the window: the app window in the desktop app, the page in a browser. */
import { isDesktop } from "./localFiles";

type Restore = (() => Promise<void>) & { entered?: boolean };
const done = (entered: boolean, fn: () => Promise<void> = async () => {}): Restore => Object.assign(fn, { entered });

/** Enters full screen. Returns a function that restores the window as it was (`.entered` says whether this call went full screen). */
export async function enterFullscreen(): Promise<Restore> {
  if (isDesktop()) {
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const win = getCurrentWindow();
      if (await win.isFullscreen()) return done(false); // already full screen: leave it that way afterwards
      await win.setFullscreen(true);
      return done(true, async () => {
        await win.setFullscreen(false).catch(() => {});
      });
    } catch {
      return done(false);
    }
  }
  if (document.fullscreenElement || !document.documentElement.requestFullscreen) return done(false);
  try {
    await document.documentElement.requestFullscreen();
  } catch {
    return done(false);
  }
  return done(true, async () => {
    if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
  });
}
