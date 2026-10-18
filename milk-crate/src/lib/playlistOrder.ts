/** Where songs from this computer sit in a playlist (see library.tsx). */

/** A song from your computers (a ripped CD or your files: "local:<path>" here, "song:…" described), not Milk Crate's catalog. */
export const isLocalTrackId = (id: string) => id.startsWith("local:") || id.startsWith("song:");

/**
 * A playlist's full order: the songs saved in your account (server), with this computer's songs
 * placed where you put them (`order`, remembered on this computer). Songs added or removed on
 * another computer are taken into account: missing ones drop out, new ones go at the end.
 */
export function mergePlaylistOrder(order: string[] | undefined, server: string[]): string[] {
  if (!order?.length) return server;
  const left = new Map<string, number>();
  for (const id of server) left.set(id, (left.get(id) ?? 0) + 1);
  const out: string[] = [];
  for (const id of order) {
    if (isLocalTrackId(id)) { out.push(id); continue; }
    const n = left.get(id) ?? 0;
    if (n > 0) { out.push(id); left.set(id, n - 1); }
  }
  for (const id of server) {
    const n = left.get(id) ?? 0;
    if (n > 0) { out.push(id); left.set(id, n - 1); }
  }
  return out;
}
