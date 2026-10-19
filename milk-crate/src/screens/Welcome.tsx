import { useEffect, useRef, useState } from "react";
import type { Go } from "../App";
import { useAuth } from "../lib/auth";
import { rememberCity, useLocation } from "../lib/location";
import type { Place } from "../lib/geo";
import { AuthForm } from "../components/AuthForm";
import { CityPicker } from "../components/CityPicker";
import { Button, MARK_PATH } from "../components/ui";
import { attachSwirl, setSwirlColors, setSwirlMoving } from "../lib/swirl";

/**
 * First run: make a listener account (or sign in, or just look around) and
 * say where you live. Your city decides your scene. The logo stands big in the
 * middle over swirling colors, with the form in a glass card below it.
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
    <div className="welcome-city">
      {!auth.session && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <h2 className="welcome-card-title">Look around first</h2>
          <p className="caption muted" style={{ margin: 0 }}>Tell us where you live and we'll show you your scene. You can make an account any time.</p>
        </div>
      )}
      <CityPicker label="Where do you live?" value={city} onChange={(p) => { setCity(p); setError(""); }} autoFocus />
      <p className="caption muted" style={{ margin: 0 }}>Your scene is your city, the towns around it, and the bigger cities in your state or province. Milk Crate covers the United States, Canada and Australia.</p>
      {error && <p role="alert" className="form-error">{error}</p>}
      <Button variant="primary" onClick={start} disabled={saving}>{saving ? "One moment…" : "Start listening"}</Button>
    </div>
  );

  return (
    <div className="welcome">
      <WelcomeSwirl />
      <div className="welcome-stack">
        <header className="welcome-hero">
          <span className="welcome-glow" aria-hidden="true" />
          <svg className="welcome-mark" viewBox="0 0 64 64" role="img" aria-label="Milk Crate"><path d={MARK_PATH} fillRule="evenodd" fill="currentColor" /></svg>
          <h1 className="welcome-word">MILK CRATE</h1>
          <p className="welcome-tagline">Keep it local.</p>
        </header>

        <section className="welcome-card" aria-label={auth.session ? "Where do you live?" : tab === "account" ? "Sign in or create an account" : "Look around first"}>
          {auth.session ? (
            <>
              <p className="caption muted" style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", margin: 0 }}>
                Signed in as {auth.email}
                <Button size="sm" onClick={() => auth.signOut()}>Sign out</Button>
              </p>
              {cityStep}
            </>
          ) : tab === "account" ? (
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
        </section>

        <div className="welcome-links">
          {!auth.session && (
            <>
              <Button size="sm" variant="ghost" onClick={() => setTab(tab === "account" ? "browse" : "account")}>
                {tab === "account" ? "Look around first" : "Sign in or make an account"}
              </Button>
              <span className="welcome-dot" aria-hidden="true">·</span>
            </>
          )}
          <Button size="sm" variant="ghost" onClick={() => go({ name: "upload" })}>Make music? Apply as an artist</Button>
        </div>
      </div>
    </div>
  );
}

/** Colors that swirl and melt into each other behind the sign-in screen (the same swirl as immersive mode). */
const WELCOME_COLORS = ["#b18cf2", "#e8838f", "#e8a948", "#4fa3a5", "#7a3f8f", "#3f5fb0"];

function WelcomeSwirl() {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!canvas.current) return;
    setSwirlColors(WELCOME_COLORS);
    setSwirlMoving(!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
    const detach = attachSwirl(canvas.current, true);
    return () => { detach(); setSwirlMoving(false); };
  }, []);
  return (
    <div className="backdrop backdrop-immersive on welcome-swirl" aria-hidden="true">
      <canvas ref={canvas} className="swirl-canvas" />
    </div>
  );
}
