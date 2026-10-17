/**
 * Feedback: "Send feedback" in the sidebar. Ideas, problems, anything. It goes
 * to the feedback table, which only reviewers can read (Review → Feedback).
 * Server side: supabase/008_fair_streams_feedback.sql.
 */
import { supabase } from "./supabase";
import { appVersion } from "./updater";
import { currentScreen } from "./errors";

export type FeedbackKind = "idea" | "problem" | "other";
export const FEEDBACK_KINDS: { id: FeedbackKind; label: string; hint: string }[] = [
  { id: "idea", label: "An idea", hint: "Something you'd like Milk Crate to do." },
  { id: "problem", label: "A problem", hint: "Something broke, or didn't work how you expected." },
  { id: "other", label: "Something else", hint: "Anything at all." },
];

export interface Feedback {
  id: number;
  kind: FeedbackKind;
  message: string;
  contactEmail?: string;
  screen?: string;
  appVersion?: string;
  platform?: string;
  status: "new" | "done";
  createdAt: string;
}

const needsUpdate = (m: string) =>
  /relation|does not exist|schema cache/i.test(m) ? "The server needs a one-time update first: run supabase/008_fair_streams_feedback.sql in the Supabase SQL Editor." : m;

export async function sendFeedback(f: { kind: FeedbackKind; message: string; contactEmail?: string }) {
  const { data } = await supabase.auth.getSession();
  const version = await appVersion().catch(() => null);
  const email = f.contactEmail?.trim();
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error("That email doesn't look right. Fix it, or leave it empty.");
  const { error } = await supabase.from("feedback").insert({
    user_id: data.session?.user.id ?? null,
    kind: f.kind,
    message: f.message.trim().slice(0, 4000),
    contact_email: email || null,
    screen: currentScreen().slice(0, 200) || null,
    app_version: version ?? "web",
    platform: navigator.userAgent.replace(/\s*\([^)]*KHTML[^)]*\)/, "").slice(0, 200),
  });
  if (error) throw new Error(needsUpdate(error.message));
}

export async function loadFeedback(): Promise<Feedback[]> {
  const { data, error } = await supabase.from("feedback").select("*").order("created_at", { ascending: false }).limit(300);
  if (error) throw new Error(needsUpdate(error.message));
  return (data ?? []).map((r) => ({
    id: Number(r.id), kind: r.kind as FeedbackKind, message: String(r.message ?? ""), contactEmail: r.contact_email ?? undefined,
    screen: r.screen ?? undefined, appVersion: r.app_version ?? undefined, platform: r.platform ?? undefined,
    status: r.status === "done" ? "done" : "new", createdAt: String(r.created_at ?? ""),
  }));
}

export async function markFeedback(id: number, status: "new" | "done") {
  const { error } = await supabase.from("feedback").update({ status }).eq("id", id);
  if (error) throw new Error(needsUpdate(error.message));
}

export async function deleteFeedback(id: number) {
  const { error } = await supabase.from("feedback").delete().eq("id", id);
  if (error) throw new Error(needsUpdate(error.message));
}
