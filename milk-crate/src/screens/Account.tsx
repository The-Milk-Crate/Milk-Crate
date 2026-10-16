import { useState } from "react";
import type { Go } from "../App";
import { useAuth } from "../lib/auth";
import { useLocation } from "../lib/location";
import { sceneSummary, type Place } from "../lib/geo";
import { AuthForm } from "../components/AuthForm";
import { CityPicker } from "../components/CityPicker";
import { Button } from "../components/ui";

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
    </div>
  );
}
