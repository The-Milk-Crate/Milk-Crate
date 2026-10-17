/**
 * Milk Crate core data model.
 *
 * These types are shared by the desktop app today and describe what the
 * backend API will serve later (see docs/architecture.md). Keep them in sync
 * with the database schema when the server exists.
 */

import type { SoundProfile } from "./sound";

export type ID = string;

/** 0 = unrated. 1–5 stars feed weighted shuffle. */
export type Rating = 0 | 1 | 2 | 3 | 4 | 5;

export type PhysicalFormat = "LP" | "7in" | "Cassette" | "CD";
export type Format = PhysicalFormat | "Digital";

export interface Artist {
  id: ID;
  /** The account that manages this artist (set for artists on the Milk Crate server). */
  ownerId?: ID;
  name: string;
  /** "Durham, NC" */
  place: string;
  city?: string;
  /** State, province or territory code: NC, ON, NSW. */
  state?: string;
  /** US, CA or AU (artists from before other countries are in the US). */
  country?: "US" | "CA" | "AU";
  lat?: number;
  lng?: number;
  /** New artists are "pending" until a reviewer approves them; only approved artists are public. */
  status: "pending" | "approved" | "declined";
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
  /** When it went up on Milk Crate (ISO time). */
  addedAt?: string;
  /** When it comes out (ISO time). Missing = out now. In the future = coming soon: its songs stay hidden until then. */
  releaseAt?: string;
}

/** When a release is (or was) out: its release date, or when it went up. */
export const outAt = (r: { releaseAt?: string; addedAt?: string }) => Date.parse(r.releaseAt ?? r.addedAt ?? "") || 0;
/** Scheduled for later and not out yet. */
export const isUpcoming = (r: { releaseAt?: string }, now = Date.now()) => !!r.releaseAt && Date.parse(r.releaseAt) > now;

export interface Track {
  id: ID;
  releaseId: ID;
  artistId: ID;
  title: string;
  /** Seconds. */
  duration: number;
  /** Playable URL. Streams from the server later; local files for now. */
  src?: string;
  /** How it sounds (tempo, energy, brightness, dynamics), measured at upload. Drives "similar sound", never popularity. */
  sound?: SoundProfile;
  /** Words, as the artist typed them. */
  lyrics?: string;
  /** Who played, wrote and recorded it, one line each ("Drums: Sam Ortiz"). */
  credits?: string;
  /** Files from your computer only: what the file's own tags say. */
  tags?: FileTags;
}

/** The tags inside an audio file from your computer (artist, album, track number, cover). */
export interface FileTags {
  artist?: string;
  albumArtist?: string;
  album?: string;
  trackNo?: number;
  discNo?: number;
  year?: number;
  /** Key of the album cover saved on this computer (see lib/fileTags.ts), when the file has one. */
  cover?: string;
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
