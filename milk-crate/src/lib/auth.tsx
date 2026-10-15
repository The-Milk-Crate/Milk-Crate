/**
 * Sign-in for artists (listeners don't need an account to browse or play).
 * Email + password, so it works inside the desktop app without browser redirects.
 */
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "./supabase";

interface Auth {
  session: Session | null;
  userId?: string;
  email?: string;
  ready: boolean;
  signIn: (email: string, password: string) => Promise<string | null>;
  signUp: (email: string, password: string) => Promise<{ error: string | null; needsConfirmation: boolean }>;
  /** Confirms a new account with the 6-digit code from the confirmation email, and signs in. */
  verifyCode: (email: string, code: string) => Promise<string | null>;
  /** Sends the confirmation email again. */
  resendCode: (email: string) => Promise<string | null>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<Auth | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setReady(true);
    });
    const { data } = supabase.auth.onAuthStateChange((_event, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, []);

  const value: Auth = {
    session,
    userId: session?.user.id,
    email: session?.user.email,
    ready,
    signIn: async (email, password) => {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      return error ? friendly(error.message) : null;
    },
    signUp: async (email, password) => {
      const { data, error } = await supabase.auth.signUp({ email, password });
      if (error) return { error: friendly(error.message), needsConfirmation: false };
      // Supabase answers a sign-up for an existing email with an empty user and sends nothing
      // (so outsiders can't probe which emails have accounts). Tell the artist to sign in.
      if (data.user && !data.session && data.user.identities?.length === 0)
        return { error: "There's already an account with that email. Sign in instead.", needsConfirmation: false };
      return { error: null, needsConfirmation: !data.session };
    },
    verifyCode: async (email, code) => {
      const { error } = await supabase.auth.verifyOtp({ email, token: code.replace(/\s/g, ""), type: "email" });
      return error ? friendly(error.message) : null;
    },
    resendCode: async (email) => {
      const { error } = await supabase.auth.resend({ type: "signup", email });
      return error ? friendly(error.message) : null;
    },
    signOut: async () => {
      await supabase.auth.signOut();
    },
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

function friendly(message: string) {
  if (/invalid login credentials/i.test(message)) return "That email and password don't match.";
  if (/email not confirmed/i.test(message)) return "Confirm your email first — enter the code we emailed you.";
  if (/expired|invalid.*(otp|token)|token.*(expired|invalid)/i.test(message)) return "That code didn't work or has expired. Check it, or send a new one.";
  if (/error sending|sending.*email|smtp/i.test(message)) return "The confirmation email couldn't be sent. Try again in a few minutes.";
  if (/not authorized/i.test(message) && /email/i.test(message)) return "Milk Crate can't email that address yet. Ask the Milk Crate team to finish email setup.";
  if (/rate limit|security purposes|too many/i.test(message)) return "Too many emails for now. Wait a few minutes and try again.";
  if (/already registered/i.test(message)) return "There's already an account with that email. Sign in instead.";
  if (/password/i.test(message) && /characters/i.test(message)) return "Use a password with at least 6 characters.";
  if (/fetch|network/i.test(message)) return "Couldn't reach the Milk Crate server. Check your internet connection.";
  return message;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}
