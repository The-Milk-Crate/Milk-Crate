/**
 * Tiny persisted-state helper. Uses localStorage for now, which the Tauri
 * webview keeps between launches. Swap for SQLite (tauri-plugin-sql) when the
 * crate gets big — see docs/architecture.md.
 */
import { useEffect, useState } from "react";

export function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function save<T>(key: string, value: T) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage full or unavailable — non-fatal */
  }
}

export function usePersistentState<T>(key: string, initial: T) {
  const [value, setValue] = useState<T>(() => load(key, initial));
  useEffect(() => save(key, value), [key, value]);
  return [value, setValue] as const;
}
