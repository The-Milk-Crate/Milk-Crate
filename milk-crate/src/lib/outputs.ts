/**
 * Where the sound plays: the computer's speakers, headphones, Bluetooth, a USB DAC, a monitor…
 *
 * Windows (and browsers): the app picks its own device (setSinkId), and the rest of the computer
 * keeps using Windows' choice. The webview only tells the devices' names once it may use audio
 * devices, so the first time it asks (nothing is recorded).
 * Mac: the web view can't pick a device, so choosing one switches the Mac's sound output, the same
 * as Control Center does (src-tauri/src/outputs.rs).
 */
import { useEffect, useSyncExternalStore } from "react";
import type { AudioOut } from "./audioOut";
import { isDesktop } from "./localFiles";

export type OutputKind = "bluetooth" | "usb" | "builtin" | "hdmi" | "airplay" | "headphones" | "other";
export interface Output { id: string; name: string; kind: OutputKind; current: boolean }

interface State {
  outputs: Output[];
  /** The app picks its own device (else the system's, on a Mac). */
  mode: "app" | "system" | "none";
  /** The webview hides the devices' names until it may use audio devices. */
  needsNames: boolean;
  error: string;
}

const KEY = "mc.outputDevice";
const saved = () => { try { return localStorage.getItem(KEY) ?? ""; } catch { return ""; } };
const remember = (id: string) => { try { if (id) localStorage.setItem(KEY, id); else localStorage.removeItem(KEY); } catch { /* fine */ } };

let state: State = { outputs: [], mode: "none", needsNames: false, error: "" };
const listeners = new Set<() => void>();
const set = (patch: Partial<State>) => { state = { ...state, ...patch }; listeners.forEach((l) => l()); };
let out: AudioOut | null = null;

const appCan = () => typeof HTMLMediaElement !== "undefined" && "setSinkId" in HTMLMediaElement.prototype && !!navigator.mediaDevices?.enumerateDevices;
const nativeMode = () => isDesktop() && !appCan();

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

/** A guess at what kind of device it is, from its name. */
export function kindOf(name: string): OutputKind {
  if (/bluetooth|airpods|buds|beats|hands-free|wh-1000|wf-1000|jbl|bose|sony wh|soundcore|\bbt\b/i.test(name)) return "bluetooth";
  if (/headphone|headset|earphone/i.test(name)) return "headphones";
  if (/hdmi|displayport|nvidia|amd high definition|monitor|\btv\b/i.test(name)) return "hdmi";
  if (/usb|dac|interface|focusrite|scarlett|schiit|fiio/i.test(name)) return "usb";
  if (/speaker|realtek|built-in|macbook/i.test(name)) return "builtin";
  return "other";
}

/** The player's sound goes through this (set up once by the player). */
export function attachOutput(o: AudioOut) {
  out = o;
  void refreshOutputs();
  const want = saved();
  if (want && appCan()) void o.setSink(want).catch(() => remember(""));
  navigator.mediaDevices?.addEventListener?.("devicechange", () => void refreshOutputs());
}

export async function refreshOutputs() {
  if (nativeMode()) {
    try {
      const list = await call<Output[]>("audio_outputs");
      set({ mode: list.length ? "system" : "none", outputs: list.map((o) => ({ ...o, kind: o.kind as OutputKind })), needsNames: false });
    } catch {
      set({ mode: "none", outputs: [] });
    }
    return;
  }
  if (!appCan()) return set({ mode: "none", outputs: [] });
  const devices = (await navigator.mediaDevices.enumerateDevices().catch(() => [])).filter((d) => d.kind === "audiooutput");
  const named = devices.filter((d) => d.label);
  const current = saved();
  // Windows lists "Default" and "Communications" as well as the devices themselves.
  const list: Output[] = [{ id: "", name: "", kind: "other", current: false }, ...named.filter((d) => d.deviceId !== "default" && d.deviceId !== "communications")
    .map((d) => ({ id: d.deviceId, name: d.label, kind: kindOf(d.label), current: false }))];
  const fallback = named.find((d) => d.deviceId === "default")?.label.replace(/^Default\s*-\s*/i, "") ?? "";
  list[0].name = fallback;
  // The one chosen before has gone (unplugged, or the Bluetooth is off): the default plays until it's back.
  const chosen = list.some((o) => o.id === current) ? current : "";
  if (current && !chosen && out) void out.setSink("").catch(() => {});
  if (current && chosen && out) void out.setSink(current).catch(() => {});
  list.forEach((o) => { o.current = o.id === chosen; });
  set({ mode: "app", outputs: list, needsNames: devices.length > 0 && named.length === 0 });
}

/** Asks for the devices' names (the webview only tells them once it may use audio devices). */
export async function showOutputNames() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
  } catch {
    set({ error: "Milk Crate wasn't allowed to see your sound devices." });
  }
  await refreshOutputs();
}

export async function chooseOutput(id: string) {
  set({ error: "" });
  try {
    if (state.mode === "system") {
      await call("set_audio_output", { id });
    } else {
      await out?.setSink(id);
      remember(id);
    }
  } catch (e) {
    set({ error: e instanceof Error ? e.message : String(e) });
  }
  await refreshOutputs();
}

export function useOutputs(watch = false): State {
  // While the list is on screen, a Mac's list is refreshed now and then (it has no device-change event here).
  useEffect(() => {
    if (!watch) return;
    void refreshOutputs();
    if (state.mode !== "system") return;
    const t = window.setInterval(() => void refreshOutputs(), 3000);
    return () => window.clearInterval(t);
  }, [watch]);
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => state);
}
