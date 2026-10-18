import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { useAuth } from "../lib/auth";
import { FEEDBACK_KINDS, sendFeedback, type FeedbackKind } from "../lib/feedback";
import { Button } from "./ui";

/** Opens the feedback form from anywhere (the app shell listens for this). */
export const openFeedback = () => window.dispatchEvent(new CustomEvent("mc:feedback"));

/**
 * "Send feedback": an idea, a problem, or anything else, straight to the Milk
 * Crate team. Works without an account. Which screen you were on and the app
 * version go along with it, so problems can be found.
 */
export function FeedbackDialog({ onClose }: { onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    box.current?.querySelector<HTMLElement>("textarea")?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("keydown", onKey); prev?.focus?.(); };
  }, [onClose]);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={box} className="modal panel" role="dialog" aria-modal="true" aria-labelledby="feedback-title">
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
            <span className="catalog eyebrow">Feedback</span>
            <h2 id="feedback-title" className="display-md">Tell the Milk Crate team</h2>
          </div>
          <button type="button" className="mc-icon-btn" aria-label="Close" onClick={onClose}><X size={18} strokeWidth={1.75} aria-hidden="true" /></button>
        </div>
        <FeedbackForm onDone={onClose} />
      </div>
    </div>
  );
}

/** The feedback form itself (in the dialog, and on Settings › Feedback). */
export function FeedbackForm({ onDone }: { onDone?: () => void }) {
  const auth = useAuth();
  const [kind, setKind] = useState<FeedbackKind>("idea");
  const [message, setMessage] = useState("");
  const [email, setEmail] = useState(auth.email ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [sent, setSent] = useState(false);

  const send = async () => {
    if (!message.trim()) return setError("Write a few words first.");
    setBusy(true);
    setError("");
    try {
      await sendFeedback({ kind, message, contactEmail: email });
      setSent(true);
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(false);
  };

  return sent ? (
    <>
      <p role="status">Thanks! It's in. {email.trim() ? `If we have questions, we'll write to ${email.trim()}.` : "Every note gets read."}</p>
      <div>{onDone ? <Button onClick={onDone}>Done</Button> : <Button onClick={() => { setSent(false); setMessage(""); }}>Send another</Button>}</div>
    </>
  ) : (
    <form style={{ display: "flex", flexDirection: "column", gap: 14 }} onSubmit={(e) => { e.preventDefault(); void send(); }}>
      <fieldset className="report-reasons">
        <legend className="catalog eyebrow">What is it?</legend>
        {FEEDBACK_KINDS.map((k) => (
          <label key={k.id} className={`report-reason${kind === k.id ? " on" : ""}`}>
            <input type="radio" name="feedback-kind" value={k.id} checked={kind === k.id} onChange={() => setKind(k.id)} />
            <span style={{ display: "flex", flexDirection: "column" }}>
              <span style={{ fontWeight: 600 }}>{k.label}</span>
              <span className="caption muted">{k.hint}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <label className="field">
        <span className="catalog eyebrow">Your message</span>
        <textarea rows={5} maxLength={4000} value={message} onChange={(e) => { setMessage(e.target.value); setError(""); }}
          placeholder={kind === "problem" ? "What happened, and what did you expect? Which song or page, if it matters." : "Go for it."} />
      </label>
      <label className="field">
        <span className="catalog eyebrow">Email for a reply (optional)</span>
        <input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <span className="caption muted">Only the Milk Crate team sees this. The app version and the screen you're on are sent too.</span>
      </label>
      {error && <p role="alert" className="form-error">{error}</p>}
      <div><Button variant="primary" type="submit" disabled={busy}>{busy ? "Sending…" : "Send feedback"}</Button></div>
    </form>
  );
}
