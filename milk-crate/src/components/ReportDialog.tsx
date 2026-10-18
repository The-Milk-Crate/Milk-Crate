import { useEffect, useRef, useState } from "react";
import { Flag, X } from "lucide-react";
import type { Go } from "../App";
import { useAuth } from "../lib/auth";
import { REASONS, submitReport, type ReportReason } from "../lib/reports";
import { Button } from "./ui";

/** A small "Report" button that opens the report form for a release or an artist. */
export function ReportButton(props: { releaseId?: string; artistId?: string; subject: string; go: Go }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
        <Flag size={13} strokeWidth={1.9} aria-hidden="true" /> Report
      </Button>
      {open && <ReportDialog {...props} onClose={() => setOpen(false)} />}
    </>
  );
}

function ReportDialog({ releaseId, artistId, subject, go, onClose }: { releaseId?: string; artistId?: string; subject: string; go: Go; onClose: () => void }) {
  const auth = useAuth();
  const [reason, setReason] = useState<ReportReason | null>(null);
  const [details, setDetails] = useState("");
  const [email, setEmail] = useState(auth.email ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [sent, setSent] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    box.current?.querySelector<HTMLElement>("input, textarea, button")?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("keydown", onKey); prev?.focus?.(); };
  }, [onClose]);

  const send = async () => {
    if (!reason) return setError("Pick what's wrong.");
    if (reason === "copyright" && details.trim().length < 20) return setError("Tell us which music is yours and how to reach you (at least a sentence).");
    setBusy(true);
    setError("");
    try {
      await submitReport({ releaseId, artistId, subject, reason, details, contactEmail: email });
      setSent(true);
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(false);
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={box} className="modal panel" role="dialog" aria-modal="true" aria-labelledby="report-title">
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
            <span className="catalog eyebrow">Report</span>
            <h2 id="report-title" className="display-md" style={{ overflowWrap: "anywhere" }}>{subject}</h2>
          </div>
          <button type="button" className="mc-icon-btn" aria-label="Close" onClick={onClose}><X size={18} strokeWidth={1.75} aria-hidden="true" /></button>
        </div>
        {!auth.session ? (
          <>
            <p className="muted">Sign in to send a report, so a reviewer can follow up with you.</p>
            <div><Button variant="primary" onClick={() => { onClose(); go({ name: "account" }); }}>Sign in</Button></div>
          </>
        ) : sent ? (
          <>
            <p role="status">Thanks. A Milk Crate reviewer will look at it{email ? ` and write to ${email} if they need more` : ""}. If it breaks the rules, it comes down.</p>
            <div><Button onClick={onClose}>Done</Button></div>
          </>
        ) : (
          <form style={{ display: "flex", flexDirection: "column", gap: 14 }} onSubmit={(e) => { e.preventDefault(); void send(); }}>
            <fieldset className="report-reasons">
              <legend className="catalog eyebrow">What's wrong?</legend>
              {REASONS.map((r) => (
                <label key={r.id} className={`report-reason${reason === r.id ? " on" : ""}`}>
                  <input type="radio" name="reason" value={r.id} checked={reason === r.id} onChange={() => { setReason(r.id); setError(""); }} />
                  <span style={{ display: "flex", flexDirection: "column" }}>
                    <span style={{ fontWeight: 600 }}>{r.label}</span>
                    <span className="caption muted">{r.hint}</span>
                  </span>
                </label>
              ))}
            </fieldset>
            <label className="field">
              <span className="catalog eyebrow">Details{reason === "copyright" ? "" : " (optional)"}</span>
              <textarea rows={4} maxLength={2000} value={details} onChange={(e) => setDetails(e.target.value)}
                placeholder={reason === "copyright" ? "Which songs are yours, where they're officially released, and that you own or represent the rights." : "Anything that helps a reviewer."} />
            </label>
            <label className="field">
              <span className="catalog eyebrow">Email for follow-up</span>
              <input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
              <span className="caption muted">Only Milk Crate reviewers see this. Never the artist or anyone else.</span>
            </label>
            {error && <p role="alert" className="form-error">{error}</p>}
            <div style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
              <Button variant="primary" type="submit" disabled={busy}>{busy ? "Sending…" : "Send report"}</Button>
              <Button variant="ghost" onClick={() => { onClose(); go({ name: "policies", doc: "copyright" }); }}>How takedowns work</Button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
