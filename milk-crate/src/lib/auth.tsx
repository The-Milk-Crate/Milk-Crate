/**
 * Accounts. Every login is either a listener account or an artist account,
 * chosen at sign-up and kept separate (supabase/003_accounts_and_places.sql
 * enforces this on the server). Reviewers (the admins table) approve artists.
 * Email + password with emailed codes, so it works inside the desktop app.
 */
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "./supabase";
import { clearSignInFailures, noteSignInFailure, signInWait } from "./security";

export type AccountKind = "listener" | "artist";

interface Auth {
  session: Session | null;
  userId?: string;
  email?: string;
  /** What kind of account is signed in (undefined while loading or signed out). */
  kind?: AccountKind;
  /** Can review artist applications. */
  isAdmin: boolean;
  ready: boolean;
  signIn: (email: string, password: string) => Promise<string | null>;
  /** `displayName` (optional) becomes the account's public display name once the email is confirmed. */
  signUp: (email: string, password: string, kind: AccountKind, displayName?: string) => Promise<{ error: string | null; needsConfirmation: boolean }>;
  /** Confirms a new account with the 6-digit code from the confirmation email, and signs in. */
  verifyCode: (email: string, code: string) => Promise<string | null>;
  /** Sends the confirmation email again. */
  resendCode: (email: string) => Promise<string | null>;
  signOut: () => Promise<void>;
  /** Signs out on every computer this account is signed in on (ends all sessions on the server). */
  signOutEverywhere: () => Promise<string | null>;
  /** Checks the signed-in account's current password (asked before sensitive changes). */
  checkPassword: (password: string) => Promise<string | null>;
  /** Forgot password: emails a code for resetting it. */
  sendPasswordReset: (email: string) => Promise<string | null>;
  /** Signs in with the reset code and sets the new password. */
  resetPassword: (email: string, code: string, password: string) => Promise<string | null>;
  /** Signed in: a new password. Needs the current one. */
  changePassword: (password: string, current: string) => Promise<string | null>;
  /** Signed in: emails codes to the new address (and the current one). Needs the current password. */
  changeEmail: (email: string, current: string) => Promise<string | null>;
  /**
   * Confirms an email change. With secure email change on (the Supabase default), both
   * addresses get a code and both are needed; `needsCurrent` means the new one worked and
   * the code sent to the current address is still missing.
   */
  confirmEmailChange: (newEmail: string, newCode: string, currentCode?: string) => Promise<{ error: string | null; done: boolean; needsCurrent?: boolean }>;
  /** Deletes this account, its uploaded files and everything in it, for good. Needs the current password. */
  deleteAccount: (current: string) => Promise<string | null>;
}

const AuthContext = createContext<Auth | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const [kind, setKind] = useState<AccountKind>();
  const [isAdmin, setIsAdmin] = useState(false);
  const userId = session?.user.id;

  // Look up the account kind and reviewer status for whoever is signed in.
  useEffect(() => {
    setKind(undefined);
    setIsAdmin(false);
    if (!userId) return;
    let live = true;
    const fromSignUp = session?.user.user_metadata?.kind === "artist" ? "artist" : "listener";
    Promise.all([
      supabase.from("accounts").select("kind").eq("user_id", userId).maybeSingle(),
      supabase.from("admins").select("user_id").eq("user_id", userId).maybeSingle(),
    ]).then(([acc, adm]) => {
      if (!live) return;
      setKind((acc.data?.kind as AccountKind | undefined) ?? fromSignUp);
      setIsAdmin(!!adm.data);
    });
    return () => {
      live = false;
    };
  }, [userId]); // eslint-disable-line react-hooks/exhaustive-deps

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
    userId,
    email: session?.user.email,
    kind,
    isAdmin,
    ready: ready && (!userId || !!kind),
    signIn: async (email, password) => {
      const wait = signInWait(email);
      if (wait) return `Too many wrong passwords. Try again in ${waitText(wait)}, or reset your password.`;
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error && /invalid login credentials/i.test(error.message)) noteSignInFailure(email);
      if (!error) clearSignInFailures(email);
      return error ? friendly(error.message) : null;
    },
    signUp: async (email, password, kind, displayName) => {
      const name = displayName?.trim();
      const { data, error } = await supabase.auth.signUp({ email, password, options: { data: name ? { kind, display_name: name } : { kind } } });
      if (error) return { error: friendly(error.message), needsConfirmation: false };
      // An email that already has an account gets the same answer as a new one (Supabase sends
      // nothing in that case), so nobody can use sign-up to find out who has an account.
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
    signOutEverywhere: async () => {
      const { error } = await supabase.auth.signOut({ scope: "global" });
      if (error) await supabase.auth.signOut({ scope: "local" });
      return error ? friendly(error.message) : null;
    },
    checkPassword: (password) => checkCurrent(session?.user.email, password),
    sendPasswordReset: async (email) => {
      const { error } = await supabase.auth.resetPasswordForEmail(email);
      return error ? friendly(error.message) : null;
    },
    resetPassword: async (email, code, password) => {
      const { error } = await supabase.auth.verifyOtp({ email, token: code.replace(/\s/g, ""), type: "recovery" });
      if (error) return friendly(error.message);
      const { error: e2 } = await supabase.auth.updateUser({ password });
      return e2 ? friendly(e2.message) : null;
    },
    changePassword: async (password, current) => {
      const wrong = await checkCurrent(session?.user.email, current);
      if (wrong) return wrong;
      const { error } = await supabase.auth.updateUser({ password });
      return error ? friendly(error.message) : null;
    },
    changeEmail: async (email, current) => {
      const wrong = await checkCurrent(session?.user.email, current);
      if (wrong) return wrong;
      const { error } = await supabase.auth.updateUser({ email });
      return error ? friendly(error.message) : null;
    },
    confirmEmailChange: async (newEmail, newCode, currentCode) => {
      const oldEmail = session?.user.email;
      const verify = (email: string, code: string) => supabase.auth.verifyOtp({ email, token: code.replace(/\s/g, ""), type: "email_change" });
      const changed = async () => {
        const { data } = await supabase.auth.refreshSession();
        return data.session?.user.email?.toLowerCase() === newEmail.toLowerCase();
      };
      const first = await verify(newEmail, newCode);
      if (first.error) return { error: friendly(first.error.message), done: false };
      if (first.data.session || (await changed())) return { error: null, done: true };
      // Only half confirmed: the current address has to confirm too.
      if (!currentCode?.trim() || !oldEmail) return { error: null, done: false, needsCurrent: true };
      const second = await verify(oldEmail, currentCode);
      if (second.error) return { error: friendly(second.error.message), done: false, needsCurrent: true };
      return (await changed()) || second.data.session ? { error: null, done: true } : { error: null, done: false, needsCurrent: true };
    },
    deleteAccount: async (current) => {
      if (!userId) return "Sign in first.";
      const wrong = await checkCurrent(session?.user.email, current);
      if (wrong) return wrong;
      // Uploaded files first (covers, songs, page photos), then the account and everything tied to it.
      for (const bucket of ["covers", "audio", "profiles"]) {
        const paths = await listAll(bucket, userId).catch(() => []);
        for (let i = 0; i < paths.length; i += 100) await supabase.storage.from(bucket).remove(paths.slice(i, i + 100));
      }
      const { error } = await supabase.rpc("delete_my_account");
      if (error) return /function|does not exist|schema cache/i.test(error.message) ? "The server needs a one-time update first: run supabase/005_accounts_reports_stats.sql in the Supabase SQL Editor." : friendly(error.message);
      await supabase.auth.signOut();
      return null;
    },
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/** Every file under a folder in a storage bucket (folders nest one level per release). */
async function listAll(bucket: string, folder: string): Promise<string[]> {
  const { data, error } = await supabase.storage.from(bucket).list(folder, { limit: 1000 });
  if (error || !data) return [];
  const out: string[] = [];
  for (const f of data) {
    const path = `${folder}/${f.name}`;
    if (f.id) out.push(path);
    else out.push(...(await listAll(bucket, path))); // a folder
  }
  return out;
}

/** Checks a signed-in person's password without changing who's signed in. */
async function checkCurrent(email: string | undefined, password: string): Promise<string | null> {
  if (!email) return "Sign in first.";
  if (!password) return "Enter your current password.";
  const wait = signInWait(email);
  if (wait) return `Too many wrong passwords. Try again in ${waitText(wait)}.`;
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (!error) {
    clearSignInFailures(email);
    return null;
  }
  if (/invalid login credentials/i.test(error.message)) {
    noteSignInFailure(email);
    return "Your current password isn't right.";
  }
  return friendly(error.message);
}

const waitText = (s: number) => (s < 60 ? `${s} seconds` : `${Math.ceil(s / 60)} minutes`);

function friendly(message: string) {
  if (/invalid login credentials/i.test(message)) return "That email and password don't match.";
  if (/email not confirmed/i.test(message)) return "Confirm your email first — enter the code we emailed you.";
  if (/expired|invalid.*(otp|token)|token.*(expired|invalid)/i.test(message)) return "That code didn't work or has expired. Check it, or send a new one.";
  if (/error sending|sending.*email|smtp/i.test(message)) return "The confirmation email couldn't be sent. Try again in a few minutes.";
  if (/not authorized/i.test(message) && /email/i.test(message)) return "Milk Crate can't email that address yet. Ask the Milk Crate team to finish email setup.";
  if (/rate limit|security purposes|too many/i.test(message)) return "Too many emails for now. Wait a few minutes and try again.";
  if (/already registered/i.test(message)) return "That email can't be used for a new account. If it's yours, sign in or reset your password.";
  if (/pwned|leaked|breach|weak.?password/i.test(message)) return "That password has shown up in a data breach, so attackers try it first. Pick a different one.";
  if (/password/i.test(message) && /characters/i.test(message)) return "Use a longer password (at least 8 characters) with a mix of letters and numbers.";
  if (/same.*password|password.*same|different from the old/i.test(message)) return "That's your current password. Pick a new one.";
  if (/reauthentication|recent.*login/i.test(message)) return "For safety, sign out and back in, then try again.";
  if (/fetch|network/i.test(message)) return "Couldn't reach the Milk Crate server. Check your internet connection.";
  return message;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}
