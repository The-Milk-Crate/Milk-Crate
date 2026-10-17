/**
 * Offline downloads: songs saved on this computer so they play without the
 * internet. The audio lives in the app's own storage (IndexedDB), never in a
 * folder people browse, and only plays inside Milk Crate.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Track } from "./types";

const DB = "milkcrate-offline";
const STORE = "audio";

export interface Download { trackId: string; releaseId: string; size: number; savedAt: number }

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function tx<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = run(t.objectStore(STORE));
    t.oncomplete = () => resolve(req ? req.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error ?? new Error("Storage full or unavailable"));
  });
}
interface Stored extends Download { blob: Blob }

/** Can this track be downloaded? (Songs on Milk Crate, not files already on this computer.) */
export const downloadable = (t: Track) => !!t.src && !t.id.startsWith("local:") && /^https?:/.test(t.src);

interface Downloads {
  /** Downloaded songs by track id. */
  byTrack: Record<string, Download>;
  /** Track ids being downloaded right now. */
  pending: Set<string>;
  totalBytes: number;
  download: (tracks: Track[]) => Promise<void>;
  remove: (trackIds: string[]) => Promise<void>;
  removeAll: () => Promise<void>;
  /** A local URL for a downloaded song, or null. */
  localUrl: (trackId: string) => Promise<string | null>;
}

const Ctx = createContext<Downloads | null>(null);

export function DownloadsProvider({ children }: { children: ReactNode }) {
  const [byTrack, setByTrack] = useState<Record<string, Download>>({});
  const [pending, setPending] = useState<Set<string>>(new Set());
  const urls = useRef(new Map<string, string>());

  useEffect(() => {
    // List what's saved (without loading the audio itself).
    const list: Record<string, Download> = {};
    open()
      .then((db) => new Promise<void>((resolve) => {
        const t = db.transaction(STORE, "readonly");
        const cur = t.objectStore(STORE).openCursor();
        cur.onsuccess = () => {
          const c = cur.result;
          if (!c) return resolve();
          const { blob: _b, ...meta } = c.value as Stored;
          list[meta.trackId] = meta;
          c.continue();
        };
        cur.onerror = () => resolve();
      }))
      .then(() => setByTrack(list))
      .catch(() => {});
  }, []);

  const download = useCallback(async (tracks: Track[]) => {
    const todo = tracks.filter((t) => downloadable(t) && !byTrack[t.id]);
    if (!todo.length) return;
    setPending((p) => new Set([...p, ...todo.map((t) => t.id)]));
    let failed = 0;
    for (const t of todo) {
      try {
        const res = await fetch(t.src!);
        if (!res.ok) throw new Error(String(res.status));
        const blob = await res.blob();
        const rec: Stored = { trackId: t.id, releaseId: t.releaseId, size: blob.size, savedAt: Date.now(), blob };
        await tx("readwrite", (s) => s.put(rec, t.id));
        const { blob: _b, ...meta } = rec;
        setByTrack((m) => ({ ...m, [t.id]: meta }));
      } catch {
        failed++;
      }
      setPending((p) => { const n = new Set(p); n.delete(t.id); return n; });
    }
    if (failed) throw new Error(failed === todo.length ? "Couldn't download. Check your internet connection, or free up disk space." : `${failed} of ${todo.length} songs couldn't be downloaded. Try again.`);
  }, [byTrack]);

  const forget = (ids: string[]) => {
    for (const id of ids) {
      const u = urls.current.get(id);
      if (u) URL.revokeObjectURL(u);
      urls.current.delete(id);
    }
    setByTrack((m) => { const n = { ...m }; for (const id of ids) delete n[id]; return n; });
  };

  const remove = useCallback(async (ids: string[]) => {
    for (const id of ids) await tx("readwrite", (s) => s.delete(id));
    forget(ids);
  }, []);

  const removeAll = useCallback(async () => {
    await tx("readwrite", (s) => s.clear());
    forget([...urls.current.keys(), ...Object.keys(byTrack)]);
  }, [byTrack]);

  const localUrl = useCallback(async (id: string) => {
    const cached = urls.current.get(id);
    if (cached) return cached;
    const rec = (await tx<Stored>("readonly", (s) => s.get(id)).catch(() => undefined)) as Stored | undefined;
    if (!rec?.blob) return null;
    const u = URL.createObjectURL(rec.blob);
    urls.current.set(id, u);
    return u;
  }, []);

  const value = useMemo<Downloads>(() => ({
    byTrack,
    pending,
    totalBytes: Object.values(byTrack).reduce((n, d) => n + d.size, 0),
    download,
    remove,
    removeAll,
    localUrl,
  }), [byTrack, pending, download, remove, removeAll, localUrl]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

const NONE: Record<string, Download> = {};
/** Downloaded songs by track id (empty outside the app's providers, e.g. in tests). */
export function useDownloadedTracks(): Record<string, Download> {
  return useContext(Ctx)?.byTrack ?? NONE;
}

export function useDownloads() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useDownloads must be used inside <DownloadsProvider>");
  return ctx;
}

/** "120 MB" */
export const formatBytes = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(n / 1e6))} MB`);
