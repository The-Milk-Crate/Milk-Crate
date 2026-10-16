import { useState } from "react";
import type { Go } from "../App";
import { useAuth } from "../lib/auth";
import { useLocation } from "../lib/location";
import { sceneSummary, type Place } from "../lib/geo";
import { AuthForm } from "../components/AuthForm";
import { CityPicker } from "../components/CityPicker";
import { Button } from "../components/ui";
import { attempt, useLibrary } from "../lib/library";
import { appVersion, checkForUpdate, installUpdate, type Update } from "../lib/updater";
import { isDesktop } from "../lib/localFiles";

/** Your city (which decides your scene) and your account. */
export function Account({ go }: { go: Go }) {
  const auth = useAuth();
  const loc = useLocation();
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
          <p className="muted">Your scene follows your artist profile's city{loc.home ? ` (${loc.home.name}, ${loc.home.state})` : ""}. Change it on the For artists screen.</p>
        ) : (
          <>
            <CityPicker label="Where do you live?" value={city} onChange={(p) => { setCity(p); setMsg(null); }} />
            {loc.scene && <p className="caption muted">Your scene now: {loc.scene.home.name}. {sceneSummary(loc.scene)}.</p>}
            {msg && <p role={msg.kind === "error" ? "alert" : "status"} className={msg.kind === "error" ? "form-error" : "form-info"}>{msg.text}</p>}
            <div><Button variant="primary" onClick={save} disabled={saving || !city || (loc.home?.name === city.name && loc.home?.state === city.state)}>{saving ? "Saving…" : "Save city"}</Button></div>
            {!auth.session && <p className="caption muted">Without an account, your city is saved on this computer only.</p>}
          </>
        )}
      </section>

      {auth.session && <DisplayName />}

      {auth.session ? (
        <section className="panel">
          <h2 className="display-md">Signed in</h2>
          <p className="muted">{auth.email}</p>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            {isArtist && <Button onClick={() => go({ name: "upload" })}>Go to For artists</Button>}
            {auth.isAdmin && <Button onClick={() => go({ name: "review" })}>Review artists</Button>}
            <Button variant="ghost" onClick={() => auth.signOut()}>Sign out</Button>
          </div>
        </section>
      ) : (
        <section style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <h2 className="display-md">Listener account</h2>
          <p className="muted">Keep your city (and soon your ratings and crate) with you on any computer. Making music? Artist accounts are separate: <button type="button" className="link-btn" onClick={() => go({ name: "upload" })}>apply here</button>.</p>
          <AuthForm kind="listener" signUpLabel="Create account" initialMode="signin" />
        </section>
      )}

      <Updates />
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

/** Check GitHub for a newer Milk Crate and install it. */
function Updates() {
  type State = { s: "idle" } | { s: "checking" } | { s: "latest" } | { s: "found"; update: Update } | { s: "installing"; pct: number | null } | { s: "error"; text: string };
  const [state, setState] = useState<State>({ s: "idle" });
  const [version, setVersion] = useState<string | null>(null);
  if (version === null) void appVersion().then((v) => setVersion(v ?? "")).catch(() => setVersion(""));

  const check = async () => {
    setState({ s: "checking" });
    try {
      const update = await checkForUpdate();
      setState(update ? { s: "found", update } : { s: "latest" });
    } catch {
      setState({ s: "error", text: "Couldn't reach GitHub to check for updates. Check your internet connection and try again." });
    }
  };
  const install = async (update: Update) => {
    setState({ s: "installing", pct: null });
    try {
      await installUpdate(update, (pct) => setState({ s: "installing", pct }));
    } catch (e) {
      setState({ s: "error", text: `The update didn't install: ${(e as Error).message}` });
    }
  };

  return (
    <section className="panel">
      <h2 className="display-md">Updates</h2>
      <p className="caption muted">{version ? `You're running Milk Crate ${version}.` : "Updates work in the installed app."} New versions come from GitHub and install themselves.</p>
      {state.s === "latest" && <p className="form-info" role="status">You're on the latest version.</p>}
      {state.s === "found" && <p className="form-info" role="status">Milk Crate {state.update.version} is ready to install. The app will restart.</p>}
      {state.s === "installing" && <p className="form-info" role="status">Updating{state.pct !== null ? ` · ${state.pct}%` : "…"} The app will restart when it's done.</p>}
      {state.s === "error" && <p className="form-error" role="alert">{state.text}</p>}
      <div style={{ display: "flex", gap: 12 }}>
        {state.s === "found" ? (
          <Button variant="primary" onClick={() => install(state.update)}>Install and restart</Button>
        ) : (
          <Button onClick={check} disabled={!isDesktop() || state.s === "checking" || state.s === "installing"}>{state.s === "checking" ? "Checking…" : "Check for updates"}</Button>
        )}
      </div>
    </section>
  );
}
