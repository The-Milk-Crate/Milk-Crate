/**
 * Milk Crate to Milk Crate on the same network: send CDs you ripped to your other computer.
 * Both are signed in to the same account; the receiving one shows a code to type on the sending one.
 * Files go straight across (never through a server). See src-tauri/cdlink.
 */
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

export const startReceiving = (account: string) => call<{ code: string; name: string }>("link_receive_start", { account });
export const stopReceiving = () => call<void>("link_receive_stop");
export const findComputers = (account: string) => call<Peer[]>("link_find", { account });
export const cancelSend = () => call<void>("link_send_cancel");

export async function onReceive(fn: (e: ReceiveEvent) => void): Promise<() => void> {
  const { listen } = await import("@tauri-apps/api/event");
  return listen<ReceiveEvent>("link-receive", (e) => fn(e.payload));
}

/** Sends the songs (and their albums' covers). Returns how many files went. */
export async function sendSongs(addr: string, code: string, account: string, songs: string[], onProgress: (p: SendProgress) => void): Promise<number> {
  const { listen } = await import("@tauri-apps/api/event");
  const stop = await listen<SendProgress>("link-send-progress", (e) => onProgress(e.payload));
  try {
    return await call<number>("link_send", { addr, code, account, songs });
  } finally {
    stop();
  }
}

/** "1.2 GB" */
export const sizeLabel = (b: number) =>
  b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : b >= 1e6 ? `${Math.round(b / 1e6)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`;
