/**
 * Milk Crate core data model.
 *
 * These types are shared by the desktop app today and describe what the
 * backend API will serve later (see docs/architecture.md). Keep them in sync
 * with the database schema when the server exists.
 */

export type ID = string;

/** 0 = unrated. 1–5 stars feed weighted shuffle. */
export type Rating = 0 | 1 | 2 | 3 | 4 | 5;

export type PhysicalFormat = "LP" | "7in" | "Cassette" | "CD";
export type Format = PhysicalFormat | "Digital";

/** A local music community: "Raleigh–Durham", "Richmond". */
export interface Scene {
  id: ID;
  name: string;
  region: string; // "NC", "VA"
  /** Neighborhoods / towns inside the scene, used for map clusters. */
  places: string[];
  /** Short human description of the sound, written by people in the scene. */
  sound?: string;
  /** Approximate center for the map, [lat, lng]. */
  center?: [number, number];
}

export interface Artist {
  id: ID;
  /** The account that manages this artist (set for artists on the Milk Crate server). */
  ownerId?: ID;
  name: string;
  sceneId: ID;
  place: string; // "Durham, NC"
  genres: string[];
  bio: string;
  /** Artist-chosen page accent — part of the customizable artist page. */
  accent: string;
  /** Year of first release; drives "up and coming" (no follower counts). */
  since: number;
  /** How the artist designed their page: photos, name lettering, logo. */
  page: ArtistPage;
}

/** An artist's page design. Every field is optional; missing ones use Milk Crate defaults. */
export interface ArtistPage {
  /** Banner photo for wide windows (landscape). */
  banner?: string;
  /** Banner photo for tall windows and phones (vertical). The page cross-fades to whichever fits. */
  bannerTall?: string;
  /** Turns off the shade along the bottom of the banner that keeps the name readable. */
  noShade?: boolean;
  /** Band logo or hand-drawn lettering, shown in the banner instead of the typed name when nameMode is "logo". */
  logo?: string;
  nameMode?: "text" | "logo";
  /** A font id from NAME_FONTS, or "custom" for an uploaded font file (fontUrl). */
  font?: string;
  fontUrl?: string;
  /** Original file name of the uploaded font, for the editor. */
  fontName?: string;
  /** Name color (#rrggbb). Absent: automatic, readable on the page color. */
  nameColor?: string;
  bold?: boolean;
  italic?: boolean;
  caps?: boolean;
  /** Letter spacing in em, -0.05 to 0.3. */
  spacing?: number;
  size?: "m" | "l" | "xl";
}

export interface Release {
  id: ID;
  artistId: ID;
  title: string;
  year: number;
  kind: "LP" | "EP" | "Single";
  catalogNumber?: string; // "PI-003"
  /** URL of artist-supplied art. Absent → generated Sleeve. */
  art?: string;
  /** Barcodes of physical editions; scanning one unlocks the digital release. */
  barcodes?: string[];
  trackIds: ID[];
}

export interface Track {
  id: ID;
  releaseId: ID;
  artistId: ID;
  title: string;
  /** Seconds. */
  duration: number;
  /** Playable URL. Streams from the server later; local files for now. */
  src?: string;
  /**
   * Sonic profile used for "sounds close to" recommendations.
   * Filled by audio analysis (tempo, energy, brightness, etc.), not by popularity.
   */
  profile?: SonicProfile;
}

export interface SonicProfile {
  tempo: number; // BPM
  energy: number; // 0–1
  brightness: number; // 0–1, spectral centroid normalized
  acousticness: number; // 0–1
  /** Embedding from an audio model, for nearest-neighbor search. */
  embedding?: number[];
}

/** Something an artist sells directly from their page. */
export interface MerchItem {
  id: ID;
  artistId: ID;
  name: string;
  note?: string;
  priceCents: number;
  /** Share of the sale that goes to the artist (platform target: 0.9). */
  artistShare: number;
  /** Physical media that unlocks a digital release when bought. */
  unlocksReleaseId?: ID;
}

export interface Show {
  id: ID;
  artistIds: ID[];
  date: string; // ISO date
  venue: string;
  city: string;
  ticketPriceCents?: number;
  ticketUrl?: string;
}

/** An item in a listener's crate (their collection). */
export interface CrateItem {
  releaseId: ID;
  format: Format;
  addedAt: string; // ISO
  /** How it got here: bought on Milk Crate, scanned from a shelf, or saved. */
  source: "purchase" | "scan" | "save";
}
