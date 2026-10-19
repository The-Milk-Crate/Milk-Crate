import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useAuth } from "../lib/auth";
import { supabase } from "../lib/supabase";
import { TERMS_VERSION, acceptedHere, rememberAccepted } from "../lib/terms";
import { Privacy, Terms } from "../screens/Policies";
import { Button } from "./ui";

/** The Terms and Privacy Policy filling the window, in a comfortable reading column, to read before agreeing. */
export function PolicyDialog({ onClose }: { onClose: () => void }) {
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    close.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); onClose(); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  // Drawn at the top of the page so it fills the window wherever it's opened from (glass cards
  // would otherwise hold it inside them).
  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal panel terms-dialog" role="dialog" aria-modal="true" aria-labelledby="terms-dialog-title">
        <header className="terms-dialog-head">
          <h2 id="terms-dialog-title" className="display-md">Terms and Privacy</h2>
          <Button ref={close} variant="primary" onClick={onClose}>Close</Button>
        </header>
        <div className="terms-dialog-body">
          <div className="policies terms-dialog-read">
            <h2 className="display-md">Terms</h2>
            <Terms />
            <h2 className="display-md">Privacy</h2>
            <Privacy />
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** "I agree to the Terms and Privacy Policy", with a way to read them. Required to make an account. */
export function AgreeToTerms({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  const [reading, setReading] = useState(false);
  return (
    <div className="terms-agree">
      <label>
        <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
        <span>I'm 13 or older (under 18, with a parent's or guardian's permission) and I agree to Milk Crate's Terms and Privacy Policy.</span>
      </label>
      <Button size="sm" onClick={() => setReading(true)}>Read them</Button>
      {reading && <PolicyDialog onClose={() => setReading(false)} />}
    </div>
  );
}

/**
 * Asks once per account: only when the account hasn't agreed to the current terms (made before
 * agreeing was asked, or TERMS_VERSION changed since). Before asking, it checks the account on the
 * server (the copy saved on this computer can be out of date) and what this computer remembers
 * agreeing to, so agreeing once is enough. Signing out is the other way out.
 */
export function TermsGate() {
  const auth = useAuth();
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // "unknown" while checking with the server; "agreed" or "ask" once known.
  const [status, setStatus] = useState<"unknown" | "agreed" | "ask">("unknown");
  const userId = auth.userId;
  const upToDate = auth.termsVersion === TERMS_VERSION;

  useEffect(() => {
    if (!auth.ready || !userId) return;
    if (upToDate) { rememberAccepted(userId); setStatus("agreed"); return; }
    let live = true;
    setStatus("unknown");
    void (async () => {
      // Agreed on this computer but the account didn't get it (offline, say): send it again, quietly.
      if (acceptedHere(userId)) {
        await auth.acceptTerms();
        if (live) setStatus("agreed");
        return;
      }
      // The account on the server may already have agreed (on another computer, or since this
      // computer last saved its copy of the session).
      const { data } = await supabase.auth.getUser();
      const fresh = data.user?.user_metadata?.terms_version;
      if (!live) return;
      if (fresh === TERMS_VERSION) { rememberAccepted(userId); setStatus("agreed"); }
      else setStatus("ask");
    })();
    return () => { live = false; };
  }, [auth.ready, userId, upToDate]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!auth.ready || !userId || upToDate || status !== "ask") return null;
  const changed = !!auth.termsVersion;
  const accept = async () => {
    if (!agreed) return setError("Check the box to agree first.");
    setBusy(true);
    const err = await auth.acceptTerms();
    setBusy(false);
    if (err) return setError(err);
    rememberAccepted(userId);
    setStatus("agreed");
  };
  return (
    <div className="modal-backdrop">
      <div className="modal panel terms-gate" role="alertdialog" aria-modal="true" aria-labelledby="terms-gate-title">
        <h2 id="terms-gate-title" className="display-md">{changed ? "Our terms changed" : "Before you go on"}</h2>
        <p>{changed
          ? "Milk Crate's Terms and Privacy Policy have been updated. Read them and agree to keep using your account."
          : "Read Milk Crate's Terms and Privacy Policy and agree to keep using your account."}</p>
        <AgreeToTerms checked={agreed} onChange={(v) => { setAgreed(v); setError(""); }} />
        {error && <p role="alert" className="form-error">{error}</p>}
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <Button variant="primary" onClick={() => void accept()} disabled={busy}>{busy ? "One moment…" : "Agree and continue"}</Button>
          <Button variant="ghost" onClick={() => void auth.signOut()} disabled={busy}>Sign out</Button>
        </div>
      </div>
    </div>
  );
}
