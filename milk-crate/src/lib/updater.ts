/**
 * Auto-update. Every push to GitHub builds a signed release (see
 * .github/workflows/build.yml). On launch, the desktop app asks GitHub
 * whether a newer version exists; if so, <UpdatePrompt> offers to install it.
 * In a browser, or in a local build without an update address, this does nothing.
 */
import { isDesktop } from "./localFiles";
import type { Update } from "@tauri-apps/plugin-updater";

export type { Update };

export async function findUpdate(): Promise<Update | null> {
  if (!isDesktop()) return null;
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    return await check();
  } catch {
    return null; // offline, no releases yet, or a local build: carry on quietly
  }
}

/** Asks GitHub for a newer version. Unlike findUpdate, a failed check throws (so the app can say so). */
export async function checkForUpdate(): Promise<Update | null> {
  if (!isDesktop()) return null;
  const { check } = await import("@tauri-apps/plugin-updater");
  return check();
}

/**
 * On a Mac, an app opened straight from its disk image, or from Downloads before
 * being moved, runs from a read-only spot macOS picks (App Translocation), so it
 * can't replace itself. Returns what to do about it, or null if the location is fine.
 */
export async function installLocationProblem(): Promise<string | null> {
  if (!isDesktop() || !/Mac/i.test(navigator.userAgent)) return null;
  try {
    const { resourceDir } = await import("@tauri-apps/api/path");
    const dir = await resourceDir();
    if (dir.startsWith("/Volumes/") || dir.includes("/AppTranslocation/"))
      return "Milk Crate is running from the disk image or a temporary spot, so it can't update itself. Quit Milk Crate, drag it into your Applications folder, open it from there, and try again.";
  } catch {
    /* can't tell: try the update anyway */
  }
  return null;
}

/** Tauri reports errors as plain text; turn whatever was thrown into a sentence a person can act on. */
export function updateErrorText(e: unknown): string {
  const raw = typeof e === "string" ? e : e instanceof Error ? e.message : (e as { message?: string })?.message ?? JSON.stringify(e);
  const why = raw && raw !== "undefined" && raw !== "{}" ? raw : "no details";
  const mac = /Mac/i.test(navigator.userAgent);
  if (/read-only|os error 30|translocat/i.test(why))
    return "Milk Crate can't replace itself from where it's running. Quit it, drag it into your Applications folder, open it from there, and try again.";
  if (/permission|denied|os error (5|13)\b|operation not permitted/i.test(why))
    return mac
      ? `Milk Crate isn't allowed to replace itself where it's installed. Move it into your Applications folder and try again. (${why})`
      : `Windows didn't let the installer run. Close Milk Crate, download the newest setup from the GitHub Releases page and run it. (${why})`;
  if (/signature/i.test(why)) return `The download didn't pass its security check, so it wasn't installed. Try again in a few minutes. (${why})`;
  if (/network|request|connect|timed? ?out|dns|tls|status/i.test(why)) return `The download didn't finish. Check your internet connection and try again. (${why})`;
  return `The update didn't install: ${why}`;
}

/** Downloads and installs the update, reporting 0–100, then restarts the app. */
export async function installUpdate(update: Update, onProgress: (pct: number | null) => void) {
  const problem = await installLocationProblem();
  if (problem) throw problem;
  let total = 0;
  let done = 0;
  await update.downloadAndInstall((e) => {
    if (e.event === "Started") total = e.data.contentLength ?? 0;
    else if (e.event === "Progress") {
      done += e.data.chunkLength;
      onProgress(total ? Math.min(100, Math.round((done / total) * 100)) : null);
    }
  });
  const { relaunch } = await import("@tauri-apps/plugin-process");
  await relaunch();
}

/** The running app's version, e.g. "0.1.12" (null in a browser). */
export async function appVersion(): Promise<string | null> {
  if (!isDesktop()) return null;
  const { getVersion } = await import("@tauri-apps/api/app");
  return getVersion();
}
