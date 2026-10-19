import { useEffect, useRef, useState } from "react";
import { useAuth } from "../lib/auth";
import { TERMS_VERSION } from "../lib/terms";
import { Privacy, Terms } from "../screens/Policies";
import { Button } from "./ui";

/** The Terms and Privacy Policy in a window, to read before agreeing. */
export function PolicyDialog({ onClose }: { onClose: () => void }) {
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    close.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); onClose(); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal panel policies terms-dialog" role="dialog" aria-modal="true" aria-labelledby="terms-dialog-title">
        <h2 id="terms-dialog-title" className="display-md">Terms</h2>
        <Terms />
        <h2 className="display-md">Privacy</h2>
        <Privacy />
        <div><Button ref={close} variant="primary" onClick={onClose}>Close</Button></div>
      </div>
    </div>
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
      <button type="button" className="link-btn caption" onClick={() => setReading(true)}>Read them</button>
      {reading && <PolicyDialog onClose={() => setReading(false)} />}
    </div>
  );
}

/**
 * Signed in to an account that hasn't agreed to the current terms (made before agreeing was
 * asked, or the terms changed since): asks before going on. Signing out is the other way out.
 */
export function TermsGate() {
  const auth = useAuth();
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (!auth.ready || !auth.userId || auth.termsVersion === TERMS_VERSION) return null;
  const changed = !!auth.termsVersion;
  const accept = async () => {
    if (!agreed) return setError("Check the box to agree first.");
    setBusy(true);
    const err = await auth.acceptTerms();
    setBusy(false);
    if (err) setError(err);
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
