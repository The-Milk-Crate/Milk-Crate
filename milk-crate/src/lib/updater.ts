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

/** Downloads and installs the update, reporting 0–100, then restarts the app. */
export async function installUpdate(update: Update, onProgress: (pct: number | null) => void) {
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
