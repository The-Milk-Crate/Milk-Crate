/**
 * Account safety helpers: password rules, a check against passwords leaked in
 * data breaches, slowing down password guessing, and keeping email addresses
 * out of public names and error reports.
 */

export const MIN_PASSWORD = 8;

/** A few of the passwords people pick most; the breach check below catches the rest. */
const COMMON = new Set([
  "password", "password1", "password123", "12345678", "123456789", "1234567890", "qwerty123", "qwertyuiop", "iloveyou", "11111111",
  "00000000", "abc12345", "letmein1", "welcome1", "sunshine", "football", "baseball", "superman", "trustno1", "milkcrate", "milkcrate1",
]);

/** Problems with a new password, before it's sent anywhere. null = fine. */
export function passwordProblem(password: string, email?: string): string | null {
  if (password.length < MIN_PASSWORD) return `Use a password with at least ${MIN_PASSWORD} characters.`;
  if (password.length > 72) return "Use a password of 72 characters or fewer.";
  const lower = password.toLowerCase();
  if (COMMON.has(lower) || /^(.)\1+$/.test(password)) return "That password is too easy to guess. Try a few unrelated words together.";
  const local = email?.split("@")[0]?.toLowerCase();
  if (local && local.length >= 4 && lower.includes(local)) return "Don't use your email address in your password.";
  return null;
}

async function sha1Hex(text: string) {
  const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
}

/**
 * How many times this password shows up in known data breaches (Have I Been
 * Pwned). Only the first 5 characters of the password's SHA-1 fingerprint
 * leave the device, never the password; the match happens here. Returns 0 if
 * the service can't be reached, so a network problem never blocks anyone.
 */
export async function breachCount(password: string, fetcher: typeof fetch = fetch): Promise<number> {
  try {
    const hash = await sha1Hex(password);
    const prefix = hash.slice(0, 5);
    const rest = hash.slice(5);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 4000);
    const res = await fetcher(`https://api.pwnedpasswords.com/range/${prefix}`, { headers: { "Add-Padding": "true" }, signal: ctl.signal });
    clearTimeout(timer);
    if (!res.ok) return 0;
    for (const line of (await res.text()).split("\n")) {
      const [suffix, count] = line.trim().split(":");
      if (suffix === rest) return Number(count) || 0;
    }
    return 0;
  } catch {
    return 0;
  }
}

/** Every rule plus the breach check. null = fine. */
export async function checkNewPassword(password: string, email?: string): Promise<string | null> {
  const problem = passwordProblem(password, email);
  if (problem) return problem;
  if ((await breachCount(password)) > 0)
    return "That password has shown up in a data breach on another site, so attackers try it first. Pick a different one.";
  return null;
}

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

/** True if the text contains an email address. */
export const hasEmail = (text: string) => new RegExp(EMAIL_RE.source, "i").test(text);

/** Replaces email addresses with [email]. */
export const redactEmails = (text: string) => text.replace(EMAIL_RE, "[email]");

/**
 * Slows down password guessing on this device: after 5 wrong tries for an
 * email, sign-in waits 30 seconds, doubling with each further miss (up to 15
 * minutes). The server has its own limits too.
 */
const FREE_TRIES = 5;
const KEY = "mc.signinFails";
type Fails = Record<string, { n: number; until: number }>;
const read = (): Fails => {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}") as Fails;
  } catch {
    return {};
  }
};
const write = (f: Fails) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(f));
  } catch {
    /* private mode */
  }
};
const keyFor = (email: string) => email.trim().toLowerCase();

/** Seconds until this email may try again (0 = now). */
export function signInWait(email: string, now = Date.now()) {
  const f = read()[keyFor(email)];
  return f && f.until > now ? Math.ceil((f.until - now) / 1000) : 0;
}
export function noteSignInFailure(email: string, now = Date.now()) {
  const all = read();
  const k = keyFor(email);
  const n = (all[k]?.n ?? 0) + 1;
  const wait = n >= FREE_TRIES ? Math.min(15 * 60, 30 * 2 ** (n - FREE_TRIES)) : 0;
  all[k] = { n, until: now + wait * 1000 };
  write(all);
}
export function clearSignInFailures(email: string) {
  const all = read();
  delete all[keyFor(email)];
  write(all);
}
