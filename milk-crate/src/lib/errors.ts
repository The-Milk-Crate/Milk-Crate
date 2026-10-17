/**
 * Error reporting: when something breaks, the app sends a short note (the
 * error, which screen, app version and system) to the error_reports table so
 * reviewers can see it under Review → Errors. No music, files or personal data:
 * email addresses are blanked out before anything is sent.
 * At most a few per session, and the same error only once.
 */
import { supabase } from "./supabase";
import { appVersion } from "./updater";
import { redactEmails } from "./security";

const MAX_PER_SESSION = 10;
const sent = new Set<string>();
let screenOf: () => string = () => "";
/** The page the person is on right now (set by reportErrors). */
export const currentScreen = () => screenOf();

/** Noise that isn't a real problem in the app. */
const IGNORE = [/ResizeObserver loop/i, /requestFullscreen/i, /AbortError/i, /The play\(\) request was interrupted/i, /NotAllowedError/i, /Load failed|Failed to fetch|NetworkError/i];

export async function sendErrorReport(error: unknown, extra?: { screen?: string }) {
  const err = error instanceof Error ? error : new Error(typeof error === "string" ? error : JSON.stringify(error));
  const message = redactEmails(err.message || String(err)).slice(0, 2000);
  if (!message || IGNORE.some((r) => r.test(message))) return;
  if (sent.has(message) || sent.size >= MAX_PER_SESSION) return;
  sent.add(message);
  try {
    const version = await appVersion().catch(() => null);
    const { data } = await supabase.auth.getSession();
    await supabase.from("error_reports").insert({
      user_id: data.session?.user.id ?? null,
      message,
      stack: err.stack ? redactEmails(err.stack).slice(0, 8000) : null,
      screen: redactEmails(extra?.screen ?? screenOf()).slice(0, 200) || null,
      app_version: version ?? "web",
      platform: navigator.userAgent.replace(/\s*\([^)]*KHTML[^)]*\)/, "").slice(0, 200),
    });
  } catch {
    /* reporting must never cause more trouble */
  }
}

/** Starts reporting uncaught errors. `screen` names the page the person is on. Returns a function that stops. */
export function reportErrors(screen: () => string): () => void {
  screenOf = screen;
  const onError = (e: ErrorEvent) => void sendErrorReport(e.error ?? e.message);
  const onRejection = (e: PromiseRejectionEvent) => void sendErrorReport(e.reason);
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
  return () => {
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection);
  };
}
