# Milk Crate

A nonprofit, artist-forward music app. Streaming that feels like digging through a record store's crates — local scenes, physical media, direct artist sales, and no charts.

This repo is the **desktop app**: a [Tauri 2](https://v2.tauri.app) shell (Rust) around a React + TypeScript UI. It builds to a Windows `.exe` and installer, and also runs on macOS and Linux.

## What works today

- **Real scenes.** On first launch people say where they live (any US city or town with 1,000+ people). Their scene is their city, the towns within 35 miles, and the larger cities in their state. The Scenes map is a real map (state borders, true city positions) with every band as a dot in its profile color at its home city, plus an "Across the country" view and a way to explore any city's scene.
- **Two kinds of accounts.** *Listener accounts* (email, password, city — kept private) and *artist accounts*, which are separate: one email is one kind, for good. People can also look around without an account (their city is saved on that computer).
- **Artists apply to join.** A new artist account sets up a profile and sends an application (links to their music, a note). Until a reviewer approves them they're hidden from listeners and can't upload music, but they can design their page. Reviewers approve or decline on the **Review artists** screen. The server enforces all of this (`supabase/003_accounts_and_places.sql`).
- **Artist pages** designed by the artist: a wide and a vertical banner that cross-fade to fit the window, with the name on one centered line inside the banner in their choice of font (or their own), color and style, or their logo or hand-drawn lettering.
- **Releases:** approved artists upload cover art and audio; WAV, AIFF and FLAC (and anything over 50 MB) become 320 kbps MP3 streaming copies.
- A real player with 1–5 star ratings and **weighted shuffle**, play files from your own computer, an **album-reactive accent**, dark and light themes, and **automatic updates** from GitHub Releases.

## Server setup (one time)

The app talks to the Supabase project in `src/config.ts`. In the Supabase dashboard open **SQL Editor → New query**, paste each file below, and click **Run**, in this order:

1. `supabase/schema.sql`: artists, releases and tracks, plus storage for covers and audio.
2. `supabase/002_artist_pages.sql`: artist page designs, plus storage for banners, logos and fonts.
3. `supabase/003_accounts_and_places.sql`: listener and artist accounts, artist approval, and real locations. Artists already on the server stay approved.
4. Make yourself a reviewer (use the email you sign in to Milk Crate with):
   ```sql
   insert into public.admins (user_id) select id from auth.users where email = 'you@example.com';
   ```
   Restart Milk Crate and a **Review artists** item appears in the sidebar. Any account can be a reviewer.

All of these are safe to run again. Then set up email:

5. Make the confirmation email send a code instead of a link (the app has no web page to land on). In **Authentication → Emails → Templates → Confirm signup**, replace the message body with:

   ```html
   <h2>Welcome to Milk Crate</h2>
   <p>Your confirmation code:</p>
   <p style="font-size:28px;font-weight:bold;letter-spacing:6px">{{ .Token }}</p>
   <p>Type it into the Milk Crate app to finish setting up your account.</p>
   ```
6. Before inviting real people: Supabase's built-in email only delivers to your own team's addresses and sends a few emails an hour. Under **Authentication → Emails → SMTP Settings**, connect a real email sender (Gmail with an app password works for a small pilot).

## Get the .exe

**Easiest — double-click `Build Milk Crate.bat`.** It checks for Node.js, Rust and the Microsoft C++ Build Tools, offers to install any that are missing (via winget), builds the app, and opens a `release` folder with:

- `Milk Crate.exe` — run it directly, no install needed
- `Milk Crate_0.1.0_x64-setup.exe` — an installer that adds a Start menu shortcut

The first build takes a while (installing the C++ tools and compiling Rust); later builds take a minute or two. If it installs tools, it asks you to run it once more afterwards so Windows picks them up.

**No installs at all — build on GitHub.** See *Automatic updates* below: every push builds the app on GitHub and publishes it on the repository's **Releases** page.

## Automatic updates

Every push to the `main` branch builds a new version (0.1.1, 0.1.2, …) on GitHub's Windows machines and publishes it as a Release. When an installed copy of Milk Crate opens, it checks for a newer Release and shows **"Milk Crate 0.1.x is ready — Update"**; one click downloads it, installs it and restarts. The sidebar shows which version you're running.

Updates are signed, so the app only accepts versions you built. One-time setup:

1. The GitHub repository must be **public** (the app reads Releases without signing in).
2. In the repository: **Settings → Secrets and variables → Actions → New repository secret**, add:
   - `TAURI_SIGNING_PRIVATE_KEY` — the private key (the long block of text from `milkcrate-signing-secrets.txt`)
   - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — its password
3. Push. Watch the build under the **Actions** tab (about 10–15 minutes the first time). When it's green, open **Releases**, download `Milk Crate_0.1.x_x64-setup.exe` and install it. That's the last manual install; from then on the app updates itself.

Keep the key and password somewhere safe (a password manager). If they're lost, generate a new pair with `npx tauri signer generate -w milkcrate.key`, put the new `.pub` contents in `src-tauri/tauri.conf.json` → `plugins.updater.pubkey`, update both secrets, and reinstall once by hand. Never commit the private key to the repository.

Copies built on your own PC with `Build Milk Crate.bat` are version 0.1.0 and also get offered the newest Release.

## Work on it

Manual setup, if you'd rather not use the script: install the **Microsoft C++ Build Tools** (tick *Desktop development with C++*), **Rust** from [rustup.rs](https://rustup.rs), and **Node.js LTS**. WebView2 is already on Windows 10 and 11. Details: [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).

```bash
npm install          # once
npm run app          # opens the desktop app with live reload
npm run app:build:win  # builds the .exe + installer
```

To work on the UI in a browser instead (no Rust needed): `npm run dev`, then open http://localhost:1420.

## Other commands

```bash
npm test             # unit tests (weighted shuffle, accent color contrast)
npm run build        # type-check + build the UI only
```

## Project map

```
src/
  App.tsx              screens + routing, theme, album-accent switch
  components/          UI primitives (ui.tsx), Sidebar, PlayerBar
  screens/             Welcome, Home, Scenes, Crate, Artists, ArtistPage, Upload (For artists), PageDesigner, Account, Review
  lib/
    types.ts           data model (Artist, Release, Track, Scene, MerchItem, Show, CrateItem)
    player.tsx         player state: queue, transport, ratings, weighted shuffle
    shuffle.ts         weighted shuffle algorithm (+ tests)
    accent.ts          album-reactive accent color math (+ tests)
    useAlbumAccent.ts  applies the accent for whatever is playing
    sleeve.ts          generated album art for releases without art
    updater.ts         checks GitHub Releases for a newer version, installs it
    transcode.ts       makes MP3 streaming copies of big/uncompressed audio (mp3.worker.ts does the encoding)
    localFiles.ts      pick audio files (native dialog in the app, file input in a browser)
    storage.ts         saved settings and ratings
    catalog.tsx        server catalog (approved artists), publishing, page designs, applications and reviews
    geo.ts             real places: city search, distances, scenes (+ tests)
    location.tsx       your home city and scene (listener account, artist profile, or this computer)
    artistPage.ts      artist page design: name fonts, styles, safety checks on saved designs
    supabase.ts        Supabase client and row mapping
    auth.tsx           accounts: listener or artist, reviewer status, sign-in with emailed codes
  config.ts            Supabase project URL + publishable key
  styles/              tokens.css (from the design system), components.css, app.css
src-tauri/             Rust desktop shell, window config, icons, permissions
supabase/schema.sql    database tables, storage buckets and permissions (run once)
supabase/002_artist_pages.sql  artist page designs + profiles storage (run once, after schema.sql)
supabase/003_accounts_and_places.sql  listener/artist accounts, approval, locations (run once, after 002)
public/cities-us.json  US cities and towns (GeoNames, CC BY 4.0); rebuild with scripts/build-cities.mjs
docs/architecture.md   where this is going: backend, payments, licensing, roadmap
scripts/               build-windows.ps1 (used by "Build Milk Crate.bat"), prepare-release.mjs (used by GitHub builds)
.github/workflows/     build.yml — builds and publishes a Release on every push (auto-update)
```

## Brand

Colors, type, logo and components come from the **Milk Crate design system** artifact. `src/styles/tokens.css` is compiled from it — when the system changes, regenerate that file rather than editing by hand.
