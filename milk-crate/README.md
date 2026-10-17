# Milk Crate

A nonprofit, artist-forward music app. Streaming that feels like digging through a record store's crates — local scenes, physical media, direct artist sales, and no charts.

This repo is the **desktop app**: a [Tauri 2](https://v2.tauri.app) shell (Rust) around a React + TypeScript UI. It builds to a Windows `.exe` and installer, and also runs on macOS and Linux.

## What works today

- **Home:** a dashboard. What's in your rotation (albums you've played most lately), new releases (ones from your scene marked "Near you"), artists to discover, and what you've recently added to your crate. Search covers artists, albums and genres.
- **Your Crate:** a shelf for each part, showing what you played last: **Albums** (whole albums, or 4+ songs from one), **Singles** (1, 2 or 3 songs from an album, marked single, double or triple), **Favorites**, **Recently Played** and **Playlists**. Click a heading for all of it. While you're in Your Crate, two more open under it in the sidebar: **Your Computer** (audio files from this computer, sorted into albums and songs by their tags and covers; never uploaded, and each account on the computer has its own list) and **Your Shelf** (the records, 45s, CDs and tapes you own, one section each: the one you're on shows big in the middle with the rest tucked behind it; flip by scrolling, dragging or arrow keys, and sort A–Z or by year). A small arrow mark shows on any song, or album with every song, that's downloaded; manage downloads in Settings → Downloads.
- **Artists:** who you follow (play straight from their albums), artists who *sound like* them, and everyone on Milk Crate. "Sounds like" uses each track's measured tempo, energy, brightness and dynamics (taken when the artist uploads); older uploads fall back to shared genres.
- **Artist and album pages are separate.** Artist pages (designed by the artist: banners, lettering, city and genre under the name) have tabs: **Music** (their top 5 songs by listeners' average rating, then their albums, newest year first) and **Sounds like**; album pages let you play, add to your crate, add songs to playlists and, under the songs, mark **I own a physical copy** (pick the format). The song that's loaded shows a pause/play button where its track number goes. **Stars on these pages are the average from everyone**, never who rated what.
- **Scenes, as record-store bins:** each town around you where a band has released music is a divider, nearest first (your own town always comes first, even with an empty bin). Open a town's bin and flip through its records: the next ones stand behind the front record with their tops showing; click one to pull it forward. A NEW sticker marks towns with a release from the past week. **Across the country** is a map of every town with bands (nearby towns share a numbered dot); pick one to see who's there and browse its bins without changing your own city.
- **Accounts:** listener accounts (city, display name, crate, follows, ratings, all private except your display name) and separate artist accounts that apply and are approved by reviewers (**Review artists**). **Settings → Updates** installs the newest version from GitHub.
- **For artists:** profile, page designer, and releases (WAV/AIFF/FLAC become 320 kbps MP3 streaming copies).
- **Liquid glass look:** frosted, translucent panels; on Windows the window itself is see-through frosted glass (acrylic). When an album plays, its cover's colors swirl slowly behind the glass (they hold still when paused and fade out when nothing's loaded). An experimental **Frosted texture** (on by default, with the clearest glass) adds very fine grain to the glass that refracts the album colors behind it, drawn by a small WebGL shader (`src/lib/frost.ts`). Text passes WCAG AA contrast over any colors at every transparency setting.
- **Player:** a seek bar with a handle you can drag, volume slider (with mute), an **EQ** button that opens the equalizer, and **immersive mode** (the expand button, or click the cover): the album full screen with its colors swirling behind it. Controls fade when the mouse rests; Esc leaves.
- **Settings:** **Appearance** (theme, your own accent color, album-reactive colors, glass on/off, glass transparency, and the experimental frosted texture), **Sound** (shuffle by your ratings, **6-band equalizer**: 60 Hz–15 kHz, ±12 dB, presets) and **Updates**.
- **Signing up** asks for your display name.

## Server setup (one time)

The app talks to the Supabase project in `src/config.ts`. In the Supabase dashboard open **SQL Editor → New query**, paste each file below, and click **Run**, in this order:

1. `supabase/schema.sql`: artists, releases and tracks, plus storage for covers and audio.
2. `supabase/002_artist_pages.sql`: artist page designs, plus storage for banners, logos and fonts.
3. `supabase/003_accounts_and_places.sql`: listener and artist accounts, artist approval, and real locations. Artists already on the server stay approved.
4. `supabase/004_crates_and_ratings.sql`: crates, physical media, playlists, follows, ratings (averages), display names, sound profiles.
5. `supabase/005_accounts_reports_stats.sql`: deleting your own account, reports and takedowns, play counts for artists' private stats, and error reports.
6. `supabase/006_countries.sql`: artists and listeners in Canada and Australia (everyone already there stays in the US).
7. `supabase/007_albums_favorites_streams.sql`: album ratings, favorite songs (songs rated 5 stars become favorites), and public stream counts.
8. `supabase/008_fair_streams_feedback.sql`: fair stream counts (replays and self-plays don't pump them up) and Send Feedback.
9. `supabase/009_listening_history.sql`: listening history in your account, so it follows you to any computer.
10. `supabase/010_lyrics_release_dates.sql`: lyrics and credits for songs, and release dates (schedule a release; its songs stay hidden until the day).
11. `supabase/011_crate_songs.sql`: single songs in Your Crate (1–3 songs from an album show under Singles as a single, double or triple).
12. Make yourself a reviewer (use the email you sign in to Milk Crate with):
   ```sql
   insert into public.admins (user_id) select id from auth.users where email = 'you@example.com';
   ```
   Restart Milk Crate and a **Review** item appears in the sidebar (artist applications, reports, feedback and errors). Any account can be a reviewer.

All of these are safe to run again. Then set up email:

13. Make the confirmation email send a code instead of a link (the app has no web page to land on). In **Authentication → Emails → Templates → Confirm signup**, replace the message body with:

   ```html
   <h2>Welcome to Milk Crate</h2>
   <p>Your confirmation code:</p>
   <p style="font-size:28px;font-weight:bold;letter-spacing:6px">{{ .Token }}</p>
   <p>Type it into the Milk Crate app to finish setting up your account.</p>
   ```
14. Do the same for **Reset Password** and **Change Email Address** (the app asks for a code for both). Any wording works as long as the body includes `{{ .Token }}`, for example:

   ```html
   <h2>Milk Crate</h2>
   <p>Your code:</p>
   <p style="font-size:28px;font-weight:bold;letter-spacing:6px">{{ .Token }}</p>
   <p>Type it into the Milk Crate app. If you didn't ask for this, ignore this email.</p>
   ```
15. Account safety settings (free). In **Authentication → Sign In / Providers → Email** (names can move a little between dashboard versions):
   - **Secure email change: on** (the default). A new email then has to be confirmed from the old address too; the app asks for both codes.
   - **Secure password change: on.** Works with the app, which already asks for the current password.
   - **Minimum password length: 8**, to match the app. Leave the character-type requirements off (the app allows passphrases like "purple tractor lamp" and turns down passwords found in data breaches itself).
   - **Email OTP expiration:** 900 seconds (15 minutes) is plenty for typing a code.
   - If your dashboard has **Authentication → Emails → Security notifications**, turn on **Password changed** and **Email address changed** so people hear about changes they didn't make.
   - Leave **Authentication → Rate Limits** at their defaults; they slow down anyone hammering sign-in or sign-up.
16. Before inviting real people: Supabase's built-in email only delivers to your own team's addresses and sends a few emails an hour. Under **Authentication → Emails → SMTP Settings**, connect a real email sender (Gmail with an app password works for a small pilot).

## Share page (clickable links)

Share copies a link like `https://the-milk-crate.github.io/Milk-Crate/?album=…`. It opens a small web page (`site/index.html`) that shows the cover and title, with **Open in Milk Crate** (opens the app) and **Get Milk Crate** (the download page). Links work in texts, Instagram, email, anywhere.

One-time setup:

1. Put `pages.yml` at the top of the repository as `.github/workflows/pages.yml` (a copy is in `milk-crate/.github/workflows/`), next to `build.yml`. Also update the top `build.yml` from the copy here (it now skips app builds when only the share page changes).
2. In the repository: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. Push. The **Share page** workflow publishes it in about a minute. After that it updates on its own whenever `site/` changes.

If the repository is ever renamed or moved, change `SHARE_PAGE` in `src/config.ts` to the new address (and the server address and key in `site/index.html` if the Supabase project changes).

## Get the app (Windows and Mac)

Every push to GitHub builds **both** versions and publishes them together on the repository's **Releases** page:

- **Windows:** `Milk.Crate_0.1.x_x64-setup.exe`. Windows may say "Windows protected your PC": click **More info → Run anyway**.
- **Mac:** `Milk.Crate_0.1.x_universal.dmg` (Apple Silicon and Intel). Open it and drag Milk Crate to Applications. The first time, macOS blocks apps from developers it doesn't know: open **System Settings → Privacy & Security** and click **Open Anyway**. (An Apple Developer account, $99/year, lets GitHub sign and notarize the app so this step disappears.)

Installed copies on both update themselves. You can also build Windows locally with `Build Milk Crate.bat`.

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
  screens/             Welcome, Home, Crate, Artists, ArtistPage, AlbumPage, Scenes, Account, Upload (For artists), PageDesigner, Review, Settings
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
    library.tsx        your crate, physical media, playlists, follows, ratings, display name
    crate.ts           how Your Crate sorts things into albums and singles/doubles/triples (+ tests)
    fileTags.ts        Your Computer: reads tags and covers from your files, groups them into albums (+ tests)
    shelf.ts           Your Shelf: sections, sorting (+ tests), flipping (wheel, drag, keys) and the soft flip sounds
    sound.ts           sound profiles: tempo, energy, brightness, dynamics (+ tests); measure.ts runs it on uploads
    similar.ts         "sounds like" recommendations (+ tests)
    settings.tsx       theme and album-color settings
    audioOut.ts        volume and the 6-band equalizer (Web Audio)
    palette.ts         album cover colors for the swirling glass background (+ tests)
    artistPage.ts      artist page design: name fonts, styles, safety checks on saved designs
    supabase.ts        Supabase client and row mapping
    auth.tsx           accounts: listener or artist, reviewer status, sign-in with emailed codes
  config.ts            Supabase project URL + publishable key
  styles/              tokens.css (from the design system), components.css, app.css, shelf.css (Your Shelf)
src-tauri/             Rust desktop shell, window config, icons, permissions
supabase/schema.sql    database tables, storage buckets and permissions (run once)
supabase/002_artist_pages.sql  artist page designs + profiles storage (run once, after schema.sql)
supabase/003_accounts_and_places.sql  listener/artist accounts, approval, locations (run once, after 002)
supabase/004_crates_and_ratings.sql   crates, playlists, follows, ratings, display names, sound (run once, after 003)
supabase/005_accounts_reports_stats.sql  account deletion, reports, play counts, error reports (run once, after 004)
supabase/006_countries.sql  Canada and Australia (run once, after 005)
supabase/007_albums_favorites_streams.sql  album ratings, favorites, stream counts (run once, after 006)
supabase/008_fair_streams_feedback.sql  fair stream counts, feedback (run once, after 007)
supabase/009_listening_history.sql  listening history (run once, after 008)
supabase/010_lyrics_release_dates.sql  lyrics, credits, release dates (run once, after 009)
supabase/011_crate_songs.sql  single songs in your crate (run once, after 010)
site/                    the share page (GitHub Pages): shared links open here, then in the app
public/cities-us.json, cities-ca.json, cities-au.json  cities and towns in the US, Canada and Australia (GeoNames, CC BY 4.0); rebuild with scripts/build-cities.mjs
src/data/regions-ca.json, regions-au.json  province and state outlines (Natural Earth, public domain); rebuild with scripts/build-regions.mjs
docs/architecture.md   where this is going: backend, payments, licensing, roadmap
scripts/               build-windows.ps1 (used by "Build Milk Crate.bat"), prepare-release.mjs (used by GitHub builds)
.github/workflows/     build.yml — builds and publishes a Release on every push (auto-update)
```

## Brand

Colors, type, logo and components come from the **Milk Crate design system** artifact. `src/styles/tokens.css` is compiled from it — when the system changes, regenerate that file rather than editing by hand.
