/**
 * Milk Crate to Milk Crate on the same network: send CDs you ripped to your other computer.
 * Both are signed in to the same account (proven with the account's secret link key, see linkKey);
 * the receiving one shows a code to type on the sending one.
 * Files go straight across (never through a server). See src-tauri/cdlink.
 */
import { supabase } from "./supabase";

export interface Peer { name: string; addr: string; sameAccount: boolean }
export type ReceiveEvent =
  | { kind: "incoming"; from: string; files: number; bytes: number }
  | { kind: "progress"; done: number; total: number; file: string }
  | { kind: "done"; from: string; files: string[] }
  | { kind: "failed"; error: string }
  | { kind: "locked" };
export interface SendProgress { done: number; total: number; file: string }

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

/**
 * The account's secret link key, kept with the account on the server (supabase/014_link_keys.sql).
 * Both computers fetch it while signed in; it's mixed into the transfer's encryption and never sent
 * over the network, so a computer signed in to a different account can't connect, code or not.
 */
let cachedKey: { user: string; key: string } | null = null;
export async function linkKey(userId: string): Promise<string> {
  if (cachedKey?.user === userId) return cachedKey.key;
  const read = () => supabase.from("link_keys").select("secret").maybeSingle();
  let { data, error } = await read();
  if (!error && !data) {
    await supabase.from("link_keys").insert({ user_id: userId }); // the server makes the key
    ({ data, error } = await read());
  }
  if (error || !data?.secret) {
    throw new Error(error && /relation|does not exist|schema cache/i.test(error.message)
      ? "The server needs a one-time update: run supabase/014_link_keys.sql in the Supabase SQL Editor."
      : "Couldn't check your account. Check your internet connection and try again.");
  }
  cachedKey = { user: userId, key: String(data.secret) };
  return cachedKey.key;
}
supabase.auth.onAuthStateChange((e) => { if (e === "SIGNED_OUT") cachedKey = null; });

export const startReceiving = async (account: string) => call<{ code: string; name: string }>("link_receive_start", { account, key: await linkKey(account) });
export const stopReceiving = () => call<void>("link_receive_stop");
export const findComputers = (account: string) => call<Peer[]>("link_find", { account });
export const cancelSend = () => call<void>("link_send_cancel");

export async function onReceive(fn: (e: ReceiveEvent) => void): Promise<() => void> {
  const { listen } = await import("@tauri-apps/api/event");
  return listen<ReceiveEvent>("link-receive", (e) => fn(e.payload));
}

/** Which of these songs the other computer already has (sent before). Needs its code. */
export const songsThere = async (addr: string, code: string, account: string, songs: string[]) => call<string[]>("link_check", { addr, code, key: await linkKey(account), songs });

/** Sends the songs (and their albums' covers); ones the other computer already has are skipped. */
export async function sendSongs(addr: string, code: string, account: string, songs: string[], onProgress: (p: SendProgress) => void): Promise<{ sent: number; skipped: number }> {
  const { listen } = await import("@tauri-apps/api/event");
  const stop = await listen<SendProgress>("link-send-progress", (e) => onProgress(e.payload));
  try {
    return await call<{ sent: number; skipped: number }>("link_send", { addr, code, key: await linkKey(account), songs });
  } finally {
    stop();
  }
}

/** "1.2 GB" */
export const sizeLabel = (b: number) =>
  b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : b >= 1e6 ? `${Math.round(b / 1e6)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`;
