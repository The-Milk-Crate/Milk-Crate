# Milk Crate — architecture and roadmap

## Today: desktop client

```
┌──────────────── Milk Crate.exe (Tauri 2) ────────────────┐
│  React + TypeScript UI (system WebView2)                 │
│   screens · player · ratings · weighted shuffle          │
│   album-reactive accent · design-system tokens           │
│                                                          │
│  Rust shell: window, file dialog, asset protocol         │
│   (plays audio files from the listener's disk)           │
└──────────────────────────────────────────────────────────┘
          data: Supabase (artists, releases, tracks) + localStorage
```

Why Tauri: installers are a few MB instead of ~150 MB (Electron), it uses the WebView2 that ships with Windows, and the Rust side is where audio analysis and a local library database will live later.

## Next: the platform

```
Desktop app ──HTTPS──► API (Node/TypeScript or Rust)
                         ├─ Postgres: artists, releases, tracks, scenes, crates, ratings, payouts
                         ├─ Object storage (Cloudflare R2 / S3): audio files, cover art
                         ├─ Audio pipeline: transcode uploads (Opus/AAC, multiple bitrates) + sonic analysis
                         ├─ Search: Meilisearch / Postgres full-text
                         └─ Payments: Stripe Connect (artists get paid directly; Milk Crate never holds the money)
```

### Core pieces and how each notebook idea maps

| Idea | How it gets built |
| --- | --- |
| Artist-forward payouts | User-centric payment: each listener's subscription is split among the artists *they* played, not a global pool. Ledger table per play-minute; monthly payout via Stripe Connect. |
| Bandcamp × Spotify | Streaming plus a store on every artist page. Merch, vinyl and tickets sold through Stripe Connect with the platform fee capped (target: artist keeps 90%). |
| Customizable artist page | Artists pick an accent, header image, layout sections; stored as JSON on the artist record and rendered by the app. |
| Scenes | Every artist has a home scene + neighborhood. Scene pages aggregate artists, releases, venues and shows. Map: MapLibre with OpenStreetMap tiles. |
| Physical media | Listeners scan a barcode (UPC/EAN). Look up the release by barcode; if the artist has opted in, the scan or a code printed on the sleeve unlocks the digital release. Otherwise it's catalogued only (Discogs API for metadata). |
| 1–5 star ratings + weighted shuffle | Done in the app (`src/lib/shuffle.ts`). Ratings sync to the server once accounts exist. |
| Sonic-profile recommendations | Analyze every upload (tempo, energy, timbre; an audio embedding model such as CLAP or Essentia's models). Store vectors in Postgres with pgvector; recommend nearest neighbors to your 4–5★ tracks. No popularity signal. |
| No top 100 | No public play counts or charts anywhere in the API or UI. Discovery comes from scenes, ratings and sound. |

### Licensing (the hard part)

- **Phase 1 — artist-uploaded only.** Artists upload music they own and agree to Milk Crate's terms. No major-label catalog. This keeps licensing to direct agreements.
- **Songwriting royalties still apply** in the US: a blanket mechanical license from the MLC and performance licenses (ASCAP, BMI, SESAC, GMR) are required for streaming, nonprofit or not. Budget for these before public launch.
- **Later:** distributor deals (DistroKid, CD Baby, etc.) to carry independent catalogs at scale.

### Nonprofit structure

Options to research with a lawyer: a 501(c)(3) (grants and donations, limits on commercial activity) vs. a cooperative / public-benefit corporation (like Subvert's co-op + PBC). NC State's entrepreneurship programs and law clinics are a good first stop.

## Roadmap

1. **Now** — desktop app shell, design system, local playback, ratings, weighted shuffle. ✅
2. **Local library** — import a folder, read ID3/FLAC tags and embedded cover art (the accent then follows real album art), SQLite via `tauri-plugin-sql`.
3. **Accounts + API** — artist sign-in and profiles ✅. Next: listener accounts that sync ratings and crate.
4. **Artist uploads** — accounts, profiles and release uploads on Supabase (Postgres + Storage). ✅ WAV/FLAC uploads become 320 kbps MP3 streaming copies in the app (Supabase free plan: 50 MB per file). Next: keep lossless masters for downloads/purchases (needs a paid storage plan), Opus/AAC at multiple bitrates, artist page editor, takedown handling.
5. **Payments** — Stripe Connect for merch/tickets, then subscriptions with user-centric payouts.
6. **Scenes** — real map, venues, show listings.
7. **Physical media** — barcode scanning (webcam) and unlock codes.
8. **Recommendations** — audio analysis + nearest-neighbor discovery.
9. **Pilot** — launch with one scene (Raleigh–Durham) before expanding.
