# Milk Crate

A nonprofit, artist-forward music app. Streaming that feels like digging through a record store's crates — local scenes, physical media, direct artist sales, and no charts.

This repo is the **desktop app**: a [Tauri 2](https://v2.tauri.app) shell (Rust) around a React + TypeScript UI. It builds to a Windows `.exe` and installer, and also runs on macOS and Linux.

## What works today

- Home, Scenes, Your Crate, Artists and artist pages, built on the Milk Crate design system. Everything shown comes from real artist accounts on the Milk Crate server; screens show a friendly empty state until artists sign up.
- A real player: add audio files from your computer (MP3, FLAC, WAV, M4A, OGG) and play them.
- 1–5 star ratings, saved between launches, and **weighted shuffle** — higher-rated tracks come up more often.
- An **album-reactive accent**: lavender by default; while something plays, the logo, play button and highlights take on the album's color. Toggle it with "Album colors" in the sidebar.
- **For artists:** sign in, set up an artist profile (name, city, genres, bio, profile color) and upload releases with cover art and audio files. WAV, AIFF and FLAC files (and anything over the server's 50 MB limit) are converted to a 320 kbps MP3 streaming copy first. Uploads go to the Milk Crate server (Supabase) and show up for every listener — Home, artist pages, search and the Scenes map.
- **Scenes map:** every band is a dot in its own profile color, grouped by neighborhood. Hover a dot to see who it is; click to open their page.
- Dark and light themes.

## Server setup (one time)

The app talks to the Supabase project in `src/config.ts`. Before the first upload:

1. In the Supabase dashboard open **SQL Editor → New query**, paste everything in `supabase/schema.sql`, and click **Run**. That creates the artists/releases/tracks tables, the `covers` and `audio` storage buckets, and the permission rules (anyone can listen; only an artist's own account can change their music).
2. Make the confirmation email send a code instead of a link (the app has no web page to land on). In **Authentication → Emails → Templates → Confirm signup**, replace the message body with:

   ```html
   <h2>Welcome to Milk Crate</h2>
   <p>Your confirmation code:</p>
   <p style="font-size:28px;font-weight:bold;letter-spacing:6px">{{ .Token }}</p>
   <p>Type it into the Milk Crate app to finish setting up your artist account.</p>
   ```

   Click **Save**. New artists then type the code into the app's **For artists** screen.
3. Before inviting real artists: Supabase's built-in email only delivers to your own team's addresses and sends a few emails an hour. Under **Authentication → Emails → SMTP Settings**, connect a real email sender (Gmail with an app password works for a small pilot).

Listeners don't need accounts. Artists create one on the **For artists** screen.

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
  screens/             Home, Scenes, Crate, Artists, ArtistPage, Upload (For artists)
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
    catalog.tsx        server catalog, shared by every screen; publishing/removing
    supabase.ts        Supabase client and row mapping
    auth.tsx           artist sign-in (email + password)
  config.ts            Supabase project URL + publishable key
  data/scenes.ts       the scene cities artists can choose, plus small formatting helpers
  styles/              tokens.css (from the design system), components.css, app.css
src-tauri/             Rust desktop shell, window config, icons, permissions
supabase/schema.sql    database tables, storage buckets and permissions (run once)
docs/architecture.md   where this is going: backend, payments, licensing, roadmap
scripts/               build-windows.ps1 (used by "Build Milk Crate.bat"), prepare-release.mjs (used by GitHub builds)
.github/workflows/     build.yml — builds and publishes a Release on every push (auto-update)
```

## Brand

Colors, type, logo and components come from the **Milk Crate design system** artifact. `src/styles/tokens.css` is compiled from it — when the system changes, regenerate that file rather than editing by hand.
