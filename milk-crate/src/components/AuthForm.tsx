import { useState, type ReactNode } from "react";
import { useAuth, type AccountKind } from "../lib/auth";
import { Button } from "./ui";
import { checkNewPassword, hasEmail, MIN_PASSWORD } from "../lib/security";

type Mode = "signin" | "signup" | "confirm" | "reset" | "resetCode";

/**
 * Sign in, create an account of one kind, or confirm it with the emailed code.
 * `signUpExtra` adds fields to the sign-up form; `beforeSignUp` checks them
 * (return an error message to stop).
 */
export function AuthForm(props: {
  kind: AccountKind;
  signUpLabel: string;
  initialMode?: "signin" | "signup";
  signUpExtra?: ReactNode;
  beforeSignUp?: () => string | null;
  /** Ask for a display name when creating the account. */
  askName?: boolean;
}) {
  const auth = useAuth();
  const [mode, setMode] = useState<Mode>(props.initialMode ?? "signin");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "error" | "info"; text: string } | null>(null);

  const toConfirm = (text: string) => {
    setMode("confirm");
    setCode("");
    setMessage({ kind: "info", text });
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setMessage(null);
    if (mode === "reset") {
      if (!email.trim()) return setMessage({ kind: "error", text: "Enter the email you signed up with." });
      setBusy(true);
      const err = await auth.sendPasswordReset(email.trim());
      setBusy(false);
      if (err) return setMessage({ kind: "error", text: err });
      setMode("resetCode");
      setCode("");
      setPassword("");
      return setMessage({ kind: "info", text: `If there's an account for ${email.trim()}, we emailed it a code. Enter it with your new password.` });
    }
    if (mode === "resetCode") {
      if (!code.trim()) return setMessage({ kind: "error", text: "Enter the code from your email." });
      setBusy(true);
      const weak = await checkNewPassword(password, email.trim());
      if (weak) { setBusy(false); return setMessage({ kind: "error", text: weak }); }
      const err = await auth.resetPassword(email.trim(), code, password);
      setBusy(false);
      if (err) setMessage({ kind: "error", text: err });
      return;
    }
    if (mode === "confirm") {
      if (!code.trim()) return setMessage({ kind: "error", text: "Enter the code from your email." });
      setBusy(true);
      const err = await auth.verifyCode(email.trim(), code);
      if (err) setMessage({ kind: "error", text: err });
      setBusy(false);
      return;
    }
    if (!email.trim() || !password) return setMessage({ kind: "error", text: "Enter your email and a password." });
    if (mode === "signup") {
      if (props.askName && !name.trim()) return setMessage({ kind: "error", text: "Choose a display name. It's what other people on Milk Crate see." });
      if (props.askName && hasEmail(name)) return setMessage({ kind: "error", text: "Leave your email out of your display name. Everyone can see it." });
      const problem = props.beforeSignUp?.();
      if (problem) return setMessage({ kind: "error", text: problem });
    }
    setBusy(true);
    if (mode === "signup") {
      const weak = await checkNewPassword(password, email.trim());
      if (weak) { setBusy(false); return setMessage({ kind: "error", text: weak }); }
    }
    if (mode === "signin") {
      const err = await auth.signIn(email.trim(), password);
      if (err && /confirm your email/i.test(err)) {
        const resendErr = await auth.resendCode(email.trim());
        toConfirm(resendErr ?? `Your email isn't confirmed yet. We sent a new code to ${email.trim()}.`);
      } else if (err) setMessage({ kind: "error", text: err });
    } else {
      const { error, needsConfirmation } = await auth.signUp(email.trim(), password, props.kind, props.askName ? name : undefined);
      if (error) setMessage({ kind: "error", text: error });
      else if (needsConfirmation) toConfirm(`If ${email.trim()} is new to Milk Crate, we emailed it a code. Enter it here (check spam too). Already have an account with this email? No code is sent: sign in or reset your password instead.`);
    }
    setBusy(false);
  };

  const resend = async () => {
    setBusy(true);
    const err = await auth.resendCode(email.trim());
    setMessage(err ? { kind: "error", text: err } : { kind: "info", text: `New code sent to ${email.trim()}.` });
    setBusy(false);
  };

  const label = busy ? "One moment…" : mode === "signin" ? "Sign in" : mode === "signup" ? props.signUpLabel : mode === "reset" ? "Email me a code" : mode === "resetCode" ? "Set new password" : "Confirm";

  return (
    <form className="panel" onSubmit={submit}>
      {mode === "reset" || mode === "resetCode" ? (
        <>
          <h2 className="display-md">Reset your password</h2>
          <label className="field">
            <span className="catalog eyebrow">Email</span>
            <input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} disabled={mode === "resetCode"} autoFocus={mode === "reset"} />
          </label>
          {mode === "resetCode" && (
            <>
              <label className="field">
                <span className="catalog eyebrow">Code from your email</span>
                <input inputMode="numeric" autoComplete="one-time-code" maxLength={10} value={code} onChange={(e) => setCode(e.target.value)}
                  style={{ fontFamily: "var(--font-mono)", letterSpacing: "0.3em", fontSize: 18 }} autoFocus />
              </label>
              <label className="field">
                <span className="catalog eyebrow">New password</span>
                <input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
                <span className="caption muted">{`At least ${MIN_PASSWORD} characters. Avoid passwords you use on other sites.`}</span>
              </label>
            </>
          )}
        </>
      ) : mode === "confirm" ? (
        <>
          <h2 className="display-md">Confirm your email</h2>
          <label className="field">
            <span className="catalog eyebrow">Code from your email</span>
            <input inputMode="numeric" autoComplete="one-time-code" maxLength={10} value={code} onChange={(e) => setCode(e.target.value)}
              style={{ fontFamily: "var(--font-mono)", letterSpacing: "0.3em", fontSize: 18 }} autoFocus />
          </label>
        </>
      ) : (
        <>
          <div role="group" aria-label="Account" className="auth-modes" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button type="button" className="chip" aria-pressed={mode === "signin"} onClick={() => { setMode("signin"); setMessage(null); }}>Sign in</button>
            <button type="button" className="chip" aria-pressed={mode === "signup"} onClick={() => { setMode("signup"); setMessage(null); }}>{props.signUpLabel}</button>
          </div>
          {mode === "signup" && props.askName && (
            <div className="field">
              <label className="catalog eyebrow" htmlFor="signup-name">Display name</label>
              <input id="signup-name" autoComplete="nickname" maxLength={40} value={name} onChange={(e) => setName(e.target.value)}
                placeholder="How you'd like to be known" aria-describedby="signup-name-hint" />
              <span id="signup-name-hint" className="caption muted">What other people on Milk Crate see (not your email). You can change it later in Account.</span>
            </div>
          )}
          <label className="field">
            <span className="catalog eyebrow">Email</span>
            <input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
          <label className="field">
            <span className="catalog eyebrow">Password</span>
            <input type="password" autoComplete={mode === "signin" ? "current-password" : "new-password"} value={password} onChange={(e) => setPassword(e.target.value)} />
            {mode === "signup" && <span className="caption muted">{`At least ${MIN_PASSWORD} characters. Avoid passwords you use on other sites.`}</span>}
          </label>
          {mode === "signup" && props.signUpExtra}
        </>
      )}
      {message && <p role={message.kind === "error" ? "alert" : "status"} className={message.kind === "error" ? "form-error" : "form-info"}>{message.text}</p>}
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 16 }}>
        <Button variant="primary" type="submit" disabled={busy}>{label}</Button>
        {mode === "signin" && (
          <Button variant="ghost" onClick={() => { setMode("reset"); setMessage(null); }}>Forgot your password?</Button>
        )}
        {(mode === "reset" || mode === "resetCode") && (
          <>
            {mode === "resetCode" && <Button disabled={busy} onClick={() => { setMode("reset"); setMessage(null); }}>Send a new code</Button>}
            <Button variant="ghost" onClick={() => { setMode("signin"); setMessage(null); }}>Back to sign in</Button>
          </>
        )}
        {mode === "confirm" && (
          <>
            <Button disabled={busy} onClick={resend}>Send a new code</Button>
            <Button variant="ghost" onClick={() => { setMode("signin"); setMessage(null); }}>Back</Button>
          </>
        )}
      </div>
    </form>
  );
}
