/**
 * Reports (anyone signed in can flag a release or an artist) and what
 * reviewers do with them: take a release down, hide an artist, or dismiss.
 * Also the error reports the app sends itself (see errors.ts).
 * Server side: supabase/005_accounts_reports_stats.sql.
 */
import { supabase } from "./supabase";

export type ReportReason = "copyright" | "not_theirs" | "offensive" | "spam" | "other";
export const REASONS: { id: ReportReason; label: string; hint: string }[] = [
  { id: "copyright", label: "It's my music (copyright)", hint: "You own this music, or represent who does, and didn't put it here." },
  { id: "not_theirs", label: "This isn't their music", hint: "The artist is passing off someone else's work as their own." },
  { id: "offensive", label: "Hateful or harmful", hint: "Hate, harassment, threats, or sexual content involving minors." },
  { id: "spam", label: "Spam or a fake artist", hint: "Junk uploads, impersonation, or an account pretending to be a band." },
  { id: "other", label: "Something else", hint: "Tell us what's wrong." },
];

export interface Report {
  id: string;
  releaseId?: string;
  artistId?: string;
  subject: string;
  reason: ReportReason;
  details: string;
  contactEmail?: string;
  status: "open" | "removed" | "dismissed";
  reviewNote?: string;
  createdAt: string;
}

const needsUpdate = (m: string) =>
  /relation|does not exist|schema cache|function/i.test(m) ? "The server needs a one-time update first: run supabase/005_accounts_reports_stats.sql in the Supabase SQL Editor." : m;

export async function submitReport(r: { releaseId?: string; artistId?: string; subject: string; reason: ReportReason; details: string; contactEmail?: string }) {
  const { error } = await supabase.from("reports").insert({
    release_id: r.releaseId ?? null,
    artist_id: r.artistId ?? null,
    subject: r.subject.slice(0, 300),
    reason: r.reason,
    details: r.details.trim().slice(0, 2000),
    contact_email: r.contactEmail?.trim() || null,
  });
  if (error) throw new Error(needsUpdate(error.message));
}

const fromRow = (r: Record<string, unknown>): Report => ({
  id: String(r.id),
  releaseId: (r.release_id as string) ?? undefined,
  artistId: (r.artist_id as string) ?? undefined,
  subject: String(r.subject ?? ""),
  reason: r.reason as ReportReason,
  details: String(r.details ?? ""),
  contactEmail: (r.contact_email as string) ?? undefined,
  status: r.status as Report["status"],
  reviewNote: (r.review_note as string) ?? undefined,
  createdAt: String(r.created_at ?? ""),
});

/** Reviewers: every report, newest first. */
export async function loadReports(): Promise<Report[]> {
  const { data, error } = await supabase.from("reports").select("*").order("created_at", { ascending: false });
  if (error) throw new Error(needsUpdate(error.message));
  return (data ?? []).map(fromRow);
}

export async function resolveReport(id: string, status: Report["status"], note?: string) {
  const { error } = await supabase.from("reports").update({ status, review_note: note?.trim() || null }).eq("id", id);
  if (error) throw new Error(needsUpdate(error.message));
}

/** Reviewers: removes a release and its cover and songs from the server. */
export async function takeDownRelease(releaseId: string, ownerId: string) {
  for (const bucket of ["covers", "audio"] as const) {
    const { data } = await supabase.storage.from(bucket).list(`${ownerId}/${releaseId}`);
    if (data?.length) await supabase.storage.from(bucket).remove(data.map((f) => `${ownerId}/${releaseId}/${f.name}`));
  }
  const { error } = await supabase.from("releases").delete().eq("id", releaseId);
  if (error) throw new Error(needsUpdate(error.message));
}

export interface ErrorReport { id: number; message: string; stack?: string; screen?: string; appVersion?: string; platform?: string; createdAt: string }

export async function loadErrorReports(): Promise<ErrorReport[]> {
  const { data, error } = await supabase.from("error_reports").select("*").order("created_at", { ascending: false }).limit(200);
  if (error) throw new Error(needsUpdate(error.message));
  return (data ?? []).map((r) => ({
    id: Number(r.id), message: String(r.message ?? ""), stack: r.stack ?? undefined, screen: r.screen ?? undefined,
    appVersion: r.app_version ?? undefined, platform: r.platform ?? undefined, createdAt: String(r.created_at ?? ""),
  }));
}

export async function clearErrorReports(ids: number[]) {
  if (!ids.length) return;
  const { error } = await supabase.from("error_reports").delete().in("id", ids);
  if (error) throw new Error(needsUpdate(error.message));
}
