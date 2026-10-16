# Milk Crate

A nonprofit, artist-forward music app. Streaming that feels like digging through a record store's crates — local scenes, physical media, direct artist sales, and no charts.

This repo is the **desktop app**: a [Tauri 2](https://v2.tauri.app) shell (Rust) around a React + TypeScript UI. It builds to a Windows `.exe` and installer, and also runs on macOS and Linux.

## What works today

- **Home:** a dashboard. What's in your rotation (albums you've played most lately), new releases (ones from your scene marked "Near you"), artists to discover, and what you've recently added to your crate. Search covers artists, albums and genres.
- **Your Crate:** albums you've saved (view them as **albums** or as a list of **songs**, sortable by date added, title, artist or your rating), your physical media (vinyl, 7", cassette, CD; adding something that's on Milk Crate puts the digital album in your crate too), playlists, and audio files from your computer. Shuffle your whole library, or play albums start to finish. **Your own star ratings live here** and steer shuffle.
- **Artists:** who you follow (play straight from their albums), artists who *sound like* them, and everyone on Milk Crate. "Sounds like" uses each track's measured tempo, energy, brightness and dynamics (taken when the artist uploads); older uploads fall back to shared genres.
- **Artist and album pages are separate.** Artist pages (designed by the artist: banners, lettering, city and genre under the name) have tabs: **Music** (their top 5 songs by listeners' average rating, then their albums, newest year first) and **Sounds like**; album pages let you play, add to your crate, add songs to playlists and, under the songs, mark **I own a physical copy** (pick the format). The song that's loaded shows a pause/play button where its track number goes. **Stars on these pages are the average from everyone**, never who rated what.
- **Scenes:** real places. Your scene is your city, the towns within 35 miles and your state's larger cities, on a real map with every band as a dot in its color.
- **Accounts:** listener accounts (city, display name, crate, follows, ratings, all private except your display name) and separate artist accounts that apply and are approved by reviewers (**Review artists**). **Settings → Updates** installs the newest version from GitHub.
- **For artists:** profile, page designer, and releases (WAV/AIFF/FLAC become 320 kbps MP3 streaming copies).
- **Liquid glass look:** frosted, translucent panels; on Windows the window itself is see-through frosted glass (acrylic). When an album plays, its cover's colors swirl slowly behind the glass (they hold still when paused and fade out when nothing's loaded). The glass has a subtle frosted texture (fine speckle, like real frosted glass). Text passes WCAG AA contrast over any colors at every transparency setting.
- **Player:** a seek bar with a handle you can drag, volume slider (with mute), an **EQ** button that opens the equalizer, and **immersive mode** (the expand button, or click the cover): the album full screen with its colors swirling behind it. Controls fade when the mouse rests; Esc leaves.
- **Settings:** **Appearance** (theme, your own accent color, album-reactive colors, glass on/off, glass transparency, and a subtle frosted texture you can turn off), **Sound** (shuffle by your ratings, **6-band equalizer**: 60 Hz–15 kHz, ±12 dB, presets) and **Updates**.
- **Signing up** asks for your display name.

## Server setup (one time)

The app talks to the Supabase project in `src/config.ts`. In the Supabase dashboard open **SQL Editor → New query**, paste each file below, and click **Run**, in this order:

1. `supabase/schema.sql`: artists, releases and tracks, plus storage for covers and audio.
2. `supabase/002_artist_pages.sql`: artist page designs, plus storage for banners, logos and fonts.
3. `supabase/003_accounts_and_places.sql`: listener and artist accounts, artist approval, and real locations. Artists already on the server stay approved.
4. `supabase/004_crates_and_ratings.sql`: crates, physical media, playlists, follows, ratings (averages), display names, sound profiles.
5. Make yourself a reviewer (use the email you sign in to Milk Crate with):
   ```sql
   insert into public.admins (user_id) select id from auth.users where email = 'you@example.com';
   ```
   Restart Milk Crate and a **Review artists** item appears in the sidebar. Any account can be a reviewer.

All of these are safe to run again. Then set up email:

6. Make the confirmation email send a code instead of a link (the app has no web page to land on). In **Authentication → Emails → Templates → Confirm signup**, replace the message body with:

   ```html
   <h2>Welcome to Milk Crate</h2>
   <p>Your confirmation code:</p>
   <p style="font-size:28px;font-weight:bold;letter-spacing:6px">{{ .Token }}</p>
   <p>Type it into the Milk Crate app to finish setting up your account.</p>
   ```
7. Before inviting real people: Supabase's built-in email only delivers to your own team's addresses and sends a few emails an hour. Under **Authentication → Emails → SMTP Settings**, connect a real email sender (Gmail with an app password works for a small pilot).

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
    sound.ts           sound profiles: tempo, energy, brightness, dynamics (+ tests); measure.ts runs it on uploads
    similar.ts         "sounds like" recommendations (+ tests)
    settings.tsx       theme and album-color settings
    audioOut.ts        volume and the 6-band equalizer (Web Audio)
    palette.ts         album cover colors for the swirling glass background (+ tests)
    artistPage.ts      artist page design: name fonts, styles, safety checks on saved designs
    supabase.ts        Supabase client and row mapping
    auth.tsx           accounts: listener or artist, reviewer status, sign-in with emailed codes
  config.ts            Supabase project URL + publishable key
  styles/              tokens.css (from the design system), components.css, app.css
src-tauri/             Rust desktop shell, window config, icons, permissions
supabase/schema.sql    database tables, storage buckets and permissions (run once)
supabase/002_artist_pages.sql  artist page designs + profiles storage (run once, after schema.sql)
supabase/003_accounts_and_places.sql  listener/artist accounts, approval, locations (run once, after 002)
supabase/004_crates_and_ratings.sql   crates, playlists, follows, ratings, display names, sound (run once, after 003)
public/cities-us.json  US cities and towns (GeoNames, CC BY 4.0); rebuild with scripts/build-cities.mjs
docs/architecture.md   where this is going: backend, payments, licensing, roadmap
scripts/               build-windows.ps1 (used by "Build Milk Crate.bat"), prepare-release.mjs (used by GitHub builds)
.github/workflows/     build.yml — builds and publishes a Release on every push (auto-update)
```

## Brand

Colors, type, logo and components come from the **Milk Crate design system** artifact. `src/styles/tokens.css` is compiled from it — when the system changes, regenerate that file rather than editing by hand.
