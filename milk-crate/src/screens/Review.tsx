import { useCallback, useEffect, useState } from "react";
import { REASONS, clearErrorReports, loadErrorReports, loadReports, resolveReport, takeDownRelease, type ErrorReport, type Report } from "../lib/reports";
import type { Go } from "../App";
import { useAuth } from "../lib/auth";
import { useCatalog, type PendingArtist } from "../lib/catalog";
import { ArtistBanner } from "../components/ArtistBanner";
import { Button, Sticker } from "../components/ui";
import { FEEDBACK_KINDS, deleteFeedback, loadFeedback, markFeedback, type Feedback } from "../lib/feedback";

type ReviewTab = "artists" | "reports" | "feedback" | "errors";

/** Reviewers: artists who applied to join, reports from listeners, feedback, and errors the app sent in. */
export function Review({ go }: { go: Go }) {
  const auth = useAuth();
  const [tab, setTab] = useState<ReviewTab>("artists");
  if (!auth.isAdmin)
    return <div className="screen"><p className="muted">Only Milk Crate reviewers can see this page.</p></div>;
  return (
    <div className="screen" style={{ maxWidth: 1000 }}>
      <header style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <span className="catalog eyebrow">Reviewer</span>
        <h1 className="display-lg">Review</h1>
      </header>
      <div role="tablist" aria-label="Review" className="segmented">
        {([["artists", "Artists"], ["reports", "Reports"], ["feedback", "Feedback"], ["errors", "Errors"]] as const).map(([id, label]) => (
          <button key={id} type="button" role="tab" className="chip" aria-selected={tab === id} aria-pressed={tab === id} onClick={() => setTab(id)}>{label}</button>
        ))}
      </div>
      {tab === "artists" && <ArtistQueue go={go} />}
      {tab === "reports" && <ReportsQueue go={go} />}
      {tab === "feedback" && <FeedbackList />}
      {tab === "errors" && <ErrorList />}
    </div>
  );
}

function ArtistQueue({ go }: { go: Go }) {
  const auth = useAuth();
  const c = useCatalog();
  const [queue, setQueue] = useState<PendingArtist[] | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    c.loadReviewQueue().then(setQueue).catch((e) => setError(String(e.message ?? e)));
  }, [c.loadReviewQueue]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (auth.isAdmin) load();
  }, [auth.isAdmin, load]);

  const pending = queue?.filter((q) => q.artist.status === "pending") ?? [];
  const declined = queue?.filter((q) => q.artist.status === "declined") ?? [];

  return (
    <>
      <p className="muted" style={{ maxWidth: 620 }}>
        New artists stay hidden, and can't upload music, until you approve them. Approved artists show up for every listener right away.
      </p>
      {error && <p role="alert" className="form-error">{error}</p>}
      {!queue && !error && <p className="muted">Loading applications…</p>}
      {queue && pending.length === 0 && <div className="empty"><span>No applications waiting. New ones show up here.</span></div>}
      {pending.map((q) => <ApplicationCard key={q.artist.id} item={q} onDone={load} go={go} />)}
      {declined.length > 0 && (
        <section className="section">
          <h2 className="display-md">Declined</h2>
          <p className="caption muted">You can still approve these later.</p>
          {declined.map((q) => <ApplicationCard key={q.artist.id} item={q} onDone={load} go={go} />)}
        </section>
      )}
    </>
  );
}

function ApplicationCard({ item: { artist: a, application: app }, onDone }: { item: PendingArtist; onDone: () => void; go: Go }) {
  const c = useCatalog();
  const [note, setNote] = useState(app?.reviewNote ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const decide = async (decision: "approved" | "declined") => {
    setBusy(true);
    setError("");
    try {
      await c.reviewArtist(a.id, decision, note.trim());
      onDone();
    } catch (e) {
      setError(String((e as Error).message));
      setBusy(false);
    }
  };

  return (
    <article className="panel review-card">
      <div className="review-banner"><ArtistBanner artist={a} fill headingLevel={2} /></div>
      <div style={{ display: "flex", flexDirection: "column", gap: 10, minWidth: 0, flex: "1 1 320px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <h2 className="display-md" style={{ margin: 0 }}>{a.name}</h2>
          <Sticker tone={a.status === "declined" ? "crate" : "dairy"}>{a.status === "declined" ? "Declined" : "Waiting"}</Sticker>
        </div>
        <p className="caption muted">{[a.place, a.genres.join(", ")].filter(Boolean).join(" · ")}</p>
        {a.bio && <p>{a.bio}</p>}
        <dl className="review-facts">
          <dt>Where to hear them</dt>
          <dd className="selectable">{app?.links || <span className="muted">No links given</span>}</dd>
          {app?.note && (<><dt>Their note</dt><dd className="selectable">{app.note}</dd></>)}
          {app?.contactEmail && (<><dt>Contact</dt><dd className="selectable">{app.contactEmail}</dd></>)}
          {app?.submittedAt && (<><dt>Applied</dt><dd>{new Date(app.submittedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</dd></>)}
        </dl>
        {!app && <p className="caption muted">They haven't sent their application yet.</p>}
        <label className="field">
          <span className="catalog eyebrow">Note to the artist (optional)</span>
          <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Shown to them with your decision." />
        </label>
        {error && <p role="alert" className="form-error">{error}</p>}
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <Button variant="primary" onClick={() => decide("approved")} disabled={busy}>Approve</Button>
          {a.status !== "declined" && <Button variant="ghost" onClick={() => decide("declined")} disabled={busy}>Decline</Button>}
        </div>
      </div>
    </article>
  );
}

const when = (iso: string) => (iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "");

/** Reports from listeners: take the release down, hide the artist, or dismiss. */
function ReportsQueue({ go }: { go: Go }) {
  const [reports, setReports] = useState<Report[] | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(() => { loadReports().then(setReports).catch((e) => setError(String(e.message ?? e))); }, []);
  useEffect(load, [load]);
  const open = reports?.filter((r) => r.status === "open") ?? [];
  const done = reports?.filter((r) => r.status !== "open") ?? [];
  return (
    <>
      <p className="muted" style={{ maxWidth: 620 }}>Check each report. If music isn't the uploader's, or breaks the rules, take it down. Write to the reporter (and the artist) from your own email when you need more.</p>
      {error && <p role="alert" className="form-error">{error}</p>}
      {!reports && !error && <p className="muted">Loading reports…</p>}
      {reports && open.length === 0 && <div className="empty"><span>No open reports.</span></div>}
      {open.map((r) => <ReportCard key={r.id} report={r} onDone={load} go={go} />)}
      {done.length > 0 && (
        <section className="section">
          <h2 className="display-md">Handled</h2>
          {done.slice(0, 30).map((r) => (
            <p key={r.id} className="caption muted">{when(r.createdAt)} · {r.subject} · {REASONS.find((x) => x.id === r.reason)?.label} · {r.status === "removed" ? "Taken down" : "Dismissed"}{r.reviewNote ? ` · ${r.reviewNote}` : ""}</p>
          ))}
        </section>
      )}
    </>
  );
}

function ReportCard({ report: r, onDone, go }: { report: Report; onDone: () => void; go: Go }) {
  const c = useCatalog();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const release = r.releaseId ? c.releaseById[r.releaseId] : undefined;
  const artist = c.artistById[release?.artistId ?? r.artistId ?? ""];
  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try { await fn(); onDone(); } catch (e) { setError(String((e as Error).message)); setBusy(false); }
  };
  return (
    <article className="panel">
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <h2 className="display-md" style={{ margin: 0, overflowWrap: "anywhere" }}>{r.subject || release?.title || artist?.name || "Reported item"}</h2>
        <Sticker tone="crate">{REASONS.find((x) => x.id === r.reason)?.label ?? r.reason}</Sticker>
      </div>
      <dl className="review-facts">
        <dt>Reported</dt><dd>{when(r.createdAt)}</dd>
        {r.details && (<><dt>Details</dt><dd className="selectable">{r.details}</dd></>)}
        {r.contactEmail && (<><dt>Reporter</dt><dd className="selectable">{r.contactEmail}</dd></>)}
      </dl>
      <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
        {release && <Button size="sm" onClick={() => go({ name: "album", releaseId: release.id })}>Open the release</Button>}
        {artist && <Button size="sm" onClick={() => go({ name: "artist", artistId: artist.id })}>Open {artist.name}</Button>}
        {!release && r.releaseId && <span className="caption muted">The release is already gone.</span>}
      </div>
      <label className="field">
        <span className="catalog eyebrow">Note (kept with the report)</span>
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="What you decided and why" />
      </label>
      {error && <p role="alert" className="form-error">{error}</p>}
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        {release && artist?.ownerId && (
          <Button variant="primary" disabled={busy} onClick={() => act(async () => { await takeDownRelease(release.id, artist.ownerId!); await resolveReport(r.id, "removed", note); await c.refresh(); })}>Take down the release</Button>
        )}
        {artist && artist.status === "approved" && (
          <Button disabled={busy} onClick={() => act(async () => { await c.reviewArtist(artist.id, "declined", note || "Hidden after a report."); await resolveReport(r.id, "removed", note || `Hid ${artist.name}`); })}>Hide the artist</Button>
        )}
        <Button variant="ghost" disabled={busy} onClick={() => act(() => resolveReport(r.id, "dismissed", note))}>Dismiss</Button>
      </div>
    </article>
  );
}

/** Feedback people sent with "Send feedback", newest first. New ones on top; mark one done once it's handled. */
function FeedbackList() {
  const [items, setItems] = useState<Feedback[] | null>(null);
  const [error, setError] = useState("");
  const [showDone, setShowDone] = useState(false);
  const load = useCallback(() => { loadFeedback().then(setItems).catch((e) => setError(String(e.message ?? e))); }, []);
  useEffect(load, [load]);
  const act = (p: Promise<unknown>) => void p.then(load).catch((e) => setError(String(e.message ?? e)));
  const open = items?.filter((f) => f.status === "new") ?? [];
  const done = items?.filter((f) => f.status === "done") ?? [];
  const label = (k: Feedback["kind"]) => FEEDBACK_KINDS.find((x) => x.id === k)?.label ?? k;
  const card = (f: Feedback) => (
    <article key={f.id} className={`panel feedback-card${f.status === "done" ? " done" : ""}`}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "baseline" }}>
        <Sticker tone={f.kind === "problem" ? "sticker" : f.kind === "idea" ? "accent" : "neutral"}>{label(f.kind)}</Sticker>
        <span className="caption muted">{when(f.createdAt)}{f.screen ? ` · on ${f.screen}` : ""}</span>
      </div>
      <p className="selectable" style={{ whiteSpace: "pre-wrap", margin: 0 }}>{f.message}</p>
      <p className="caption muted" style={{ margin: 0 }}>
        {f.contactEmail ? <>Reply to <span className="selectable">{f.contactEmail}</span> · </> : "No reply email · "}
        {[f.appVersion, f.platform].filter(Boolean).join(" · ")}
      </p>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        {f.status === "new"
          ? <Button size="sm" onClick={() => act(markFeedback(f.id, "done"))}>Mark done</Button>
          : <Button size="sm" variant="ghost" onClick={() => act(markFeedback(f.id, "new"))}>Move back to new</Button>}
        <Button size="sm" variant="ghost" onClick={() => act(deleteFeedback(f.id))}>Delete</Button>
      </div>
    </article>
  );
  return (
    <>
      <p className="muted" style={{ maxWidth: 620 }}>Ideas and problems people sent from the app. Write back from your own email when they left one.</p>
      {error && <p role="alert" className="form-error">{error}</p>}
      {!items && !error && <p className="muted">Loading…</p>}
      {items && open.length === 0 && <div className="empty"><span>Nothing new. {done.length ? `${done.length} handled.` : ""}</span></div>}
      {open.map(card)}
      {done.length > 0 && (
        <>
          <div><Button aria-expanded={showDone} onClick={() => setShowDone((v) => !v)}>{showDone ? "Hide" : "Show"} {done.length} handled</Button></div>
          {showDone && done.map(card)}
        </>
      )}
    </>
  );
}

/** Errors the app sent in, newest first. */
function ErrorList() {
  const [errors, setErrors] = useState<ErrorReport[] | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(() => { loadErrorReports().then(setErrors).catch((e) => setError(String(e.message ?? e))); }, []);
  useEffect(load, [load]);
  return (
    <>
      <p className="muted" style={{ maxWidth: 620 }}>When something breaks in someone's app, it sends a short note here. Repeats of the same message are grouped.</p>
      {error && <p role="alert" className="form-error">{error}</p>}
      {!errors && !error && <p className="muted">Loading…</p>}
      {errors && errors.length === 0 && <div className="empty"><span>No errors reported.</span></div>}
      {errors && errors.length > 0 && (
        <>
          <div><Button size="sm" variant="ghost" onClick={() => void clearErrorReports(errors.map((e) => e.id)).then(load).catch((e) => setError(String(e.message)))}>Clear all</Button></div>
          {groupErrors(errors).map((g) => (
            <details key={g.message} className="panel error-group">
              <summary><strong className="selectable">{g.message}</strong> <span className="caption muted">· {g.items.length}× · last {when(g.items[0].createdAt)}{g.items[0].screen ? ` · ${g.items[0].screen}` : ""}</span></summary>
              <p className="caption muted">{[...new Set(g.items.map((i) => [i.appVersion, i.platform].filter(Boolean).join(" · ")))].join(" | ")}</p>
              {g.items[0].stack && <pre className="error-stack selectable">{g.items[0].stack}</pre>}
            </details>
          ))}
        </>
      )}
    </>
  );
}

function groupErrors(errors: ErrorReport[]) {
  const groups = new Map<string, ErrorReport[]>();
  for (const e of errors) groups.set(e.message, [...(groups.get(e.message) ?? []), e]);
  return [...groups.entries()].map(([message, items]) => ({ message, items }));
}
