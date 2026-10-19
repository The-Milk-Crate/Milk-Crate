import { useState } from "react";
import type { Go } from "../App";
import { useAuth } from "../lib/auth";
import { useLiveScene, useLocation } from "../lib/location";
import { sceneSummary, type Place } from "../lib/geo";
import { AuthForm } from "../components/AuthForm";
import { CityPicker } from "../components/CityPicker";
import { Button } from "../components/ui";
import { replayTutorial } from "../components/Tutorial";
import { attempt, useLibrary } from "../lib/library";
import { checkNewPassword, hasEmail, MIN_PASSWORD } from "../lib/security";

/** Your city (which decides your scene) and your account. */
export function Account({ go }: { go: Go }) {
  const auth = useAuth();
  const loc = useLocation();
  const shown = useLiveScene(loc.scene);
  const [city, setCity] = useState<Place | null>(loc.home);
  const [msg, setMsg] = useState<{ kind: "error" | "info"; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const isArtist = auth.kind === "artist";

  const save = async () => {
    if (!city) return setMsg({ kind: "error", text: "Pick your city or town from the list." });
    setSaving(true);
    setMsg(null);
    try {
      await loc.setHome(city);
      setMsg({ kind: "info", text: `Your scene is now ${city.name}.` });
    } catch (e) {
      setMsg({ kind: "error", text: `Couldn't save your city: ${(e as Error).message}` });
    }
    setSaving(false);
  };

  return (
    <div className="screen" style={{ maxWidth: 640 }}>
      <header style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <span className="catalog eyebrow">{auth.session ? (isArtist ? "Artist account" : "Listener account") : "Not signed in"}</span>
        <h1 className="display-lg">Account</h1>
      </header>

      <section className="panel">
        <h2 className="display-md">Your city</h2>
        {isArtist ? (
          <p className="muted">Your scene follows your artist profile's city{loc.home ? ` (${loc.home.name}, ${loc.home.state})` : ""}. Change it on the For Artists screen.</p>
        ) : (
          <>
            <CityPicker label="Where do you live?" value={city} onChange={(p) => { setCity(p); setMsg(null); }} />
            {shown && <p className="caption muted">Your scene now: {shown.home.name}.{sceneSummary(shown) ? ` ${sceneSummary(shown)}.` : ""}</p>}
            {msg && <p role={msg.kind === "error" ? "alert" : "status"} className={msg.kind === "error" ? "form-error" : "form-info"}>{msg.text}</p>}
            <div><Button variant="primary" onClick={save} disabled={saving || !city || (loc.home?.name === city.name && loc.home?.state === city.state)}>{saving ? "Saving…" : "Save city"}</Button></div>
            {!auth.session && <p className="caption muted">Without an account, your city is saved on this computer only.</p>}
          </>
        )}
      </section>

      {auth.session && <DisplayName />}

      <section className="panel">
        <h2 className="display-md">Tutorial</h2>
        <p className="muted">Take the quick tour of Milk Crate again: what each part of the app is for, one stop at a time.</p>
        <div><Button onClick={replayTutorial}>Replay the tutorial</Button></div>
      </section>

      {auth.session ? (
        <section className="panel">
          <h2 className="display-md">Signed in</h2>
          <p className="muted">{auth.email}</p>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            {isArtist && <Button onClick={() => go({ name: "upload" })}>Go to For Artists</Button>}
            {auth.isAdmin && <Button onClick={() => go({ name: "review" })}>Review artists</Button>}
            <Button variant="ghost" onClick={() => auth.signOut()}>Sign out</Button>
          </div>
        </section>
      ) : null}

      {auth.session ? (
        <>
          <SignInDetails />
          <DeleteAccount isArtist={isArtist} />
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Button size="sm" variant="ghost" onClick={() => go({ name: "policies", doc: "mission" })}>Our mission</Button>
            <Button size="sm" variant="ghost" onClick={() => go({ name: "policies", doc: "terms" })}>Terms</Button>
            <Button size="sm" variant="ghost" onClick={() => go({ name: "policies", doc: "privacy" })}>Privacy</Button>
            <Button size="sm" variant="ghost" onClick={() => go({ name: "policies", doc: "copyright" })}>Copyright and takedowns</Button>
          </div>
        </>
      ) : (
        <section style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <h2 className="display-md">Listener account</h2>
          <p className="muted">Keep your city (and soon your ratings and crate) with you on any computer. Making music? Artist accounts are separate.</p>
          <div><Button size="sm" onClick={() => go({ name: "upload" })}>Apply as an artist</Button></div>
          <AuthForm kind="listener" askName signUpLabel="Create account" initialMode="signin" />
        </section>
      )}

    </div>
  );
}

/** The name other people see. */
function DisplayName() {
  const lib = useLibrary();
  const [name, setName] = useState(lib.displayName ?? "");
  const [msg, setMsg] = useState<{ kind: "error" | "info"; text: string } | null>(null);
  const [last, setLast] = useState(lib.displayName);
  if (lib.displayName !== last) { setLast(lib.displayName); setName(lib.displayName ?? ""); }
  const save = () => {
    if (!name.trim()) return setMsg({ kind: "error", text: "Enter a name (up to 40 characters)." });
    if (hasEmail(name)) return setMsg({ kind: "error", text: "Leave your email out of your display name. Everyone can see it." });
    void attempt(async () => { await lib.setDisplayName(name); setMsg({ kind: "info", text: "Saved." }); }, (m) => setMsg({ kind: "error", text: m }));
  };
  return (
    <section className="panel">
      <h2 className="display-md">Display name</h2>
      <p className="caption muted">What other people on Milk Crate see. Not your email.</p>
      <form style={{ display: "flex", gap: 12, alignItems: "flex-end", flexWrap: "wrap" }} onSubmit={(e) => { e.preventDefault(); save(); }}>
        <label className="field" style={{ flex: "1 1 240px" }}>
          <span className="catalog eyebrow">Name</span>
          <input value={name} maxLength={40} onChange={(e) => { setName(e.target.value); setMsg(null); }} placeholder="How you'd like to be known" />
        </label>
        <Button variant="primary" type="submit" disabled={name.trim() === (lib.displayName ?? "")}>Save</Button>
      </form>
      {msg && <p role={msg.kind === "error" ? "alert" : "status"} className={msg.kind === "error" ? "form-error" : "form-info"}>{msg.text}</p>}
    </section>
  );
}

type Msg = { kind: "error" | "info"; text: string } | null;
const Note = ({ msg }: { msg: Msg }) => (msg ? <p role={msg.kind === "error" ? "alert" : "status"} className={msg.kind === "error" ? "form-error" : "form-info"}>{msg.text}</p> : null);

/**
 * Change the email you sign in with or your password. Both ask for the current
 * password first, so nobody at an unlocked computer can take the account over.
 * A new email is confirmed with codes sent to the new address and the current one.
 */
function SignInDetails() {
  const auth = useAuth();
  const [email, setEmail] = useState("");
  const [current, setCurrent] = useState("");
  const [code, setCode] = useState("");
  const [oldCode, setOldCode] = useState("");
  const [pendingEmail, setPendingEmail] = useState<string | null>(null);
  const [emailMsg, setEmailMsg] = useState<Msg>(null);
  const [password, setPassword] = useState("");
  const [passCurrent, setPassCurrent] = useState("");
  const [passMsg, setPassMsg] = useState<Msg>(null);
  const [busy, setBusy] = useState(false);
  const oldEmail = auth.email ?? "your current address";

  const sendEmail = async () => {
    const next = email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(next)) return setEmailMsg({ kind: "error", text: "Enter the new email address." });
    if (next.toLowerCase() === auth.email?.toLowerCase()) return setEmailMsg({ kind: "error", text: "That's already your email." });
    setBusy(true);
    const err = await auth.changeEmail(next, current);
    setBusy(false);
    if (err) return setEmailMsg({ kind: "error", text: err });
    setPendingEmail(next);
    setCurrent("");
    setCode("");
    setOldCode("");
    setEmailMsg({ kind: "info", text: `We emailed a code to ${next}, and one to ${oldEmail} to make sure the change is really you. Enter both.` });
  };
  const confirmEmail = async () => {
    if (!pendingEmail || !code.trim()) return setEmailMsg({ kind: "error", text: `Enter the code sent to ${pendingEmail}.` });
    setBusy(true);
    const r = await auth.confirmEmailChange(pendingEmail, code, oldCode);
    setBusy(false);
    if (r.error) return setEmailMsg({ kind: "error", text: r.error });
    if (!r.done) return setEmailMsg({ kind: "error", text: `Almost there: also enter the code sent to ${oldEmail}.` });
    setEmailMsg({ kind: "info", text: `You now sign in with ${pendingEmail}.` });
    setPendingEmail(null);
    setEmail("");
  };
  const savePassword = async () => {
    setBusy(true);
    const weak = await checkNewPassword(password, auth.email);
    if (weak) { setBusy(false); return setPassMsg({ kind: "error", text: weak }); }
    const err = await auth.changePassword(password, passCurrent);
    setBusy(false);
    setPassMsg(err ? { kind: "error", text: err } : { kind: "info", text: "Password changed. Other computers stay signed in; use Sign out everywhere below if you're worried someone else has it." });
    if (!err) { setPassword(""); setPassCurrent(""); }
  };
  const codeStyle = { fontFamily: "var(--font-mono)", letterSpacing: "0.3em", fontSize: 18 } as const;

  return (
    <section className="panel">
      <h2 className="display-md">Sign-in details</h2>
      <form style={{ display: "flex", flexDirection: "column", gap: 12 }} onSubmit={(e) => { e.preventDefault(); void (pendingEmail ? confirmEmail() : sendEmail()); }}>
        {pendingEmail ? (
          <>
            <label className="field">
              <span className="catalog eyebrow">Code sent to {pendingEmail}</span>
              <input inputMode="numeric" autoComplete="one-time-code" maxLength={10} value={code} onChange={(e) => setCode(e.target.value)} style={codeStyle} autoFocus />
            </label>
            <label className="field">
              <span className="catalog eyebrow">Code sent to {oldEmail}</span>
              <input inputMode="numeric" autoComplete="off" maxLength={10} value={oldCode} onChange={(e) => setOldCode(e.target.value)} style={codeStyle} />
            </label>
          </>
        ) : (
          <>
            <label className="field">
              <span className="catalog eyebrow">New email</span>
              <input type="email" autoComplete="email" value={email} placeholder={auth.email} onChange={(e) => { setEmail(e.target.value); setEmailMsg(null); }} />
            </label>
            {email.trim() && (
              <label className="field">
                <span className="catalog eyebrow">Current password</span>
                <input type="password" autoComplete="current-password" value={current} onChange={(e) => { setCurrent(e.target.value); setEmailMsg(null); }} />
              </label>
            )}
          </>
        )}
        <Note msg={emailMsg} />
        <div style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
          <Button type="submit" disabled={busy || (!pendingEmail && (!email.trim() || !current))}>{pendingEmail ? "Confirm new email" : "Change email"}</Button>
          {pendingEmail && <Button variant="ghost" onClick={() => { setPendingEmail(null); setEmailMsg(null); }}>Cancel</Button>}
        </div>
      </form>
      <form style={{ display: "flex", flexDirection: "column", gap: 12, borderTop: "1px solid var(--line)", paddingTop: 16 }} onSubmit={(e) => { e.preventDefault(); void savePassword(); }}>
        <label className="field">
          <span className="catalog eyebrow">Current password</span>
          <input type="password" autoComplete="current-password" value={passCurrent} onChange={(e) => { setPassCurrent(e.target.value); setPassMsg(null); }} />
        </label>
        <label className="field">
          <span className="catalog eyebrow">New password</span>
          <input type="password" autoComplete="new-password" value={password} onChange={(e) => { setPassword(e.target.value); setPassMsg(null); }} />
          <span className="caption muted">At least {MIN_PASSWORD} characters. Passwords found in data breaches aren't allowed.</span>
        </label>
        <Note msg={passMsg} />
        <div><Button type="submit" disabled={busy || !password || !passCurrent}>{busy ? "Checking…" : "Change password"}</Button></div>
      </form>
      <SignOutEverywhere />
    </section>
  );
}

/** Ends every session for this account, on every computer, including this one. */
function SignOutEverywhere() {
  const auth = useAuth();
  const [sure, setSure] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, borderTop: "1px solid var(--line)", paddingTop: 16 }}>
      <p className="caption muted">Signed in somewhere you shouldn't be, or lost a computer? Sign out everywhere, then change your password.</p>
      <div style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
        {sure ? (
          <>
            <Button onClick={() => void auth.signOutEverywhere().then((e) => e && setMsg({ kind: "error", text: e }))}>Yes, sign out everywhere</Button>
            <Button variant="ghost" onClick={() => setSure(false)}>Cancel</Button>
          </>
        ) : (
          <Button variant="ghost" onClick={() => setSure(true)}>Sign out everywhere</Button>
        )}
      </div>
      <Note msg={msg} />
    </div>
  );
}

/** Delete the account and everything in it, after typing DELETE to be sure. */
function DeleteAccount({ isArtist }: { isArtist: boolean }) {
  const auth = useAuth();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [current, setCurrent] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  const run = async () => {
    setBusy(true);
    const err = await auth.deleteAccount(current);
    setBusy(false);
    if (err) setMsg({ kind: "error", text: err });
  };
  return (
    <section className="panel danger-zone">
      <h2 className="display-md">Delete account</h2>
      <p className="muted">
        This deletes your account for good: {isArtist ? "your artist page, every release you've put out and its songs and art, " : ""}your crate, ratings, playlists and follows.
        It can't be undone. Songs you downloaded stay on this computer until you remove them.
      </p>
      {open ? (
        <form style={{ display: "flex", flexDirection: "column", gap: 12 }} onSubmit={(e) => { e.preventDefault(); if (typed === "DELETE" && current) void run(); }}>
          <label className="field">
            <span className="catalog eyebrow">Type DELETE to confirm</span>
            <input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" autoFocus />
          </label>
          <label className="field">
            <span className="catalog eyebrow">Your password</span>
            <input type="password" autoComplete="current-password" value={current} onChange={(e) => { setCurrent(e.target.value); setMsg(null); }} />
          </label>
          <Note msg={msg} />
          <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
            <button type="submit" className="mc-btn danger-btn" disabled={typed !== "DELETE" || !current || busy}>{busy ? "Deleting…" : "Delete my account"}</button>
            <Button variant="ghost" onClick={() => { setOpen(false); setTyped(""); setCurrent(""); }}>Cancel</Button>
          </div>
        </form>
      ) : (
        <div><button type="button" className="mc-btn danger-btn" onClick={() => setOpen(true)}>Delete account…</button></div>
      )}
    </section>
  );
}
