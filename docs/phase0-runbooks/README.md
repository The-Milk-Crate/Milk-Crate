# Phase 0 runbooks

Step-by-step runbooks for the three things K Marcus runs by hand after session J4. Each has a
tracker spreadsheet with one row per step and a Status column: the `.xlsx` opens in Excel with a
Status dropdown, and the `.csv` holds the same rows for anything else.

| Runbook | Tracker | What it is |
| --- | --- | --- |
| [`supabase-stand-up.md`](supabase-stand-up.md) | `supabase-stand-up.xlsx`, `.csv` | Standing up Phase 0 on a separate free Supabase project and a Fly app |
| [`sandbox-run.md`](sandbox-run.md) | `sandbox-run.xlsx`, `.csv` | Step 9 of `docs/phase0-handoff.md`: the larger AWS sandbox run |
| [`ffmpeg-5.1-tests.md`](ffmpeg-5.1-tests.md) | `ffmpeg-5.1-tests.xlsx`, `.csv` | J4's new worker tests on Debian's ffmpeg 5.1, locally in Docker |

Written 25 November 2026, from the repository as it was then. If a script, the workflow or the
handoff changes, update the runbook and its tracker with it. The trackers here are blank
templates: copy one somewhere outside the repository to fill in, so a run's notes are not
committed by accident.

Open questions noted in the runbooks:
- `MC_SITE_URL` for the Supabase project (`http://localhost:1420` assumed).
- No verified email domain yet, so invitation emails cannot send through Resend.
- The Fly token command (`flyctl tokens create org`) was not checked; its `--help` comes first.
- The processing smoke check for step 9 and the test-account helper are not built yet.
