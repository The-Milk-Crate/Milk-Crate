/**
 * Scenes are the cities Milk Crate is organized around. Artists pick one when
 * they set up their profile. Add a city here to open a new scene.
 */
import type { Scene } from "../lib/types";

export const scenes: Scene[] = [
  { id: "rdu", name: "Raleigh–Durham", region: "NC", places: ["Raleigh", "Durham", "Carrboro", "Chapel Hill"], sound: "Indie rock, folk punk, bedroom pop", center: [35.85, -78.8] },
  { id: "avl", name: "Asheville", region: "NC", places: ["Asheville"], sound: "Bluegrass, folk" },
  { id: "ric", name: "Richmond", region: "VA", places: ["Richmond"], sound: "Hardcore, post-punk" },
  { id: "ath", name: "Athens", region: "GA", places: ["Athens"], sound: "Jangle pop, psych" },
  { id: "phl", name: "Philadelphia", region: "PA", places: ["Philadelphia"], sound: "Emo, indie rock" },
  { id: "chi", name: "Chicago", region: "IL", places: ["Chicago"], sound: "Footwork, jazz" },
];

export const byId = <T extends { id: string }>(list: T[]) => Object.fromEntries(list.map((x) => [x.id, x])) as Record<string, T>;
export const sceneById = byId(scenes);

export const formatPrice = (cents: number) => `$${(cents / 100).toFixed(cents % 100 ? 2 : 0)}`;
export const formatTime = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
