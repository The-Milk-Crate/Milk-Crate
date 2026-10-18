import { useState } from "react";
import type { Go } from "../App";
import { useAuth } from "../lib/auth";
import { rememberCity, useLocation } from "../lib/location";
import type { Place } from "../lib/geo";
import { AuthForm } from "../components/AuthForm";
import { CityPicker } from "../components/CityPicker";
import { Button, MARK_PATH } from "../components/ui";

/**
 * First run: make a listener account (or sign in, or just look around) and
 * say where you live. Your city decides your scene.
 */
export function Welcome({ go }: { go: Go }) {
  const auth = useAuth();
  const loc = useLocation();
  const [tab, setTab] = useState<"account" | "browse">("account");
  const [city, setCity] = useState<Place | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const start = async () => {
    if (!city) return setError("Pick your city or town from the list.");
    setSaving(true);
    setError("");
    try {
      await loc.setHome(city);
    } catch (e) {
      setError(`Couldn't save your city: ${(e as Error).message}`);
      setSaving(false);
    }
  };

  const cityStep = (
    <div className="panel">
      <CityPicker label="Where do you live?" value={city} onChange={(p) => { setCity(p); setError(""); }} autoFocus />
      <p className="caption muted">Your scene is your city, the towns around it, and the bigger cities in your state or province. Milk Crate covers the United States, Canada and Australia.</p>
      {error && <p role="alert" className="form-error">{error}</p>}
      <div><Button variant="primary" onClick={start} disabled={saving}>{saving ? "One moment…" : "Start listening"}</Button></div>
    </div>
  );

  return (
    <div className="welcome">
      <div className="welcome-inner">
        <section className="welcome-pitch">
          <svg className="welcome-mark" viewBox="0 0 64 64" aria-hidden="true"><path d={MARK_PATH} fillRule="evenodd" fill="currentColor" /></svg>
          <h1 className="display-xl">Milk Crate.</h1>
        </section>

        <section className="welcome-form">
          {auth.session ? (
            <>
              <p className="caption muted" style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
                Signed in as {auth.email}
                <Button size="sm" onClick={() => auth.signOut()}>Sign out</Button>
              </p>
              {cityStep}
            </>
          ) : (
            <>
              <div role="tablist" aria-label="Get started" className="segmented">
                <button type="button" role="tab" className="chip" aria-selected={tab === "account"} aria-pressed={tab === "account"} onClick={() => setTab("account")}>Listener account</button>
                <button type="button" role="tab" className="chip" aria-selected={tab === "browse"} aria-pressed={tab === "browse"} onClick={() => setTab("browse")}>Look around first</button>
              </div>
              {tab === "account" ? (
                <AuthForm
                  kind="listener"
                  signUpLabel="Create account"
                  askName
                  initialMode="signup"
                  signUpExtra={<CityPicker label="Where do you live?" value={city} onChange={setCity} />}
                  beforeSignUp={() => {
                    if (!city) return "Pick your city or town from the list.";
                    rememberCity(city); // saved to your account once you confirm your email
                    return null;
                  }}
                />
              ) : (
                cityStep
              )}
            </>
          )}
          <div className="welcome-artist" style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 10 }}>
            <p className="caption muted" style={{ margin: 0 }}>Make music? Artist accounts are separate from listener accounts, and new artists are reviewed before their music goes live.</p>
            <Button size="sm" onClick={() => go({ name: "upload" })}>Apply to join as an artist</Button>
          </div>
        </section>
      </div>
    </div>
  );
}
