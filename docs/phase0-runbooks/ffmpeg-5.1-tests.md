# ffmpeg 5.1 tests: step by step

Written 25 November 2026. Tracker: `ffmpeg-5.1-tests.xlsx` (or `.csv`) in this folder.

These tests show J4's fix (#47) works on the ffmpeg the worker images really use, Debian
bookworm's 5.1. They run on your machine with Docker, take about 5 minutes, and touch no cloud
account.

## The steps

Run these in WSL, one at a time, with Docker Desktop running (WSL integration on).

**Step 1. Go to your checkout and bring it up to date.**

```bash
cd /mnt/e/GitHub/Milk-Crate && git checkout milk-crate-backend-poc && git pull
```

Expected: `worker/test/untrusted.test.ts` exists (`ls worker/test`).

**Step 2. Install the packages the tests load, if missing.** The tests load the `postgres`
package from `deploy/supabase`. Skip this step if `deploy/supabase/node_modules` already exists.

```bash
(cd deploy/supabase && npm ci)
```

Expected: `added ... packages`, no error.

**Step 3. Build the test image.** It is the worker images' pinned base image with their exact
ffmpeg line. The first build downloads ffmpeg, which takes a few minutes.

```bash
docker build -t mc-ffmpeg51 - <<'EOF'
FROM node:22.23.5-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
EOF
```

Expected: the build ends with `naming to docker.io/library/mc-ffmpeg51`.

**Step 4. Run the tests in it, with your checkout mounted.**

```bash
docker run --rm -v "$PWD":/repo -w /repo/worker mc-ffmpeg51 sh -c 'ffmpeg -hide_banner -version | head -n1 && node --test --test-reporter=spec test/untrusted.test.ts'
```

Expected, in about 5 seconds:

| Line | Means |
| --- | --- |
| `ffmpeg version 5.1...` | The tests ran on Debian's 5.1, not your own ffmpeg |
| `✔ ffprobe and ffmpeg refuse a playlist or concat file saved as a WAV, and open no URL` | No format guessing, no network |
| `✔ with the format forced, a FLAC still needs its own marker; ...` | The `fLaC` check |
| `✔ ffprobe and ffmpeg get only PATH, and still process a WAV, AIFF and FLAC` | Only `PATH` reaches ffmpeg, and real files still decode |
| `﹣ untrusted masters through the processing step (local Postgres) ... # needs MC_TEST_DB_URL` | Skipped: it needs the test database. The same check runs in CI on 6.1. |
| `ℹ tests 3`, `ℹ pass 3`, `ℹ fail 0` | All passed |

## Reading the result

`pass 3` and `fail 0` on ffmpeg 5.1 means the fix holds on the real images. Record it for the
handoff: the date, the `ffmpeg version` line and "3 pass".

| What you see | What it means | What to do |
| --- | --- | --- |
| `pass 3`, `fail 0`, ffmpeg 5.1 | The fix works on 5.1 | Record it; done |
| The first test fails, saying the server got a request | ffmpeg 5.1 opened a URL despite the fix | Stop. This is a security finding: bring the whole output to a session before the sandbox run |
| Another test fails | 5.1 reads a file differently from 6.1 | Bring the whole output to a session |
| `Cannot find package 'postgres'` | Step 2 was skipped | Run step 2, then step 4 again |
| `ffmpeg version 6...` or another version | The wrong image ran | Check that step 3 finished and step 4 names `mc-ffmpeg51` |
| `Cannot connect to the Docker daemon` | Docker Desktop is not running, or WSL integration is off | Start it, turn on WSL integration for your distribution, then run again |

Warnings about locale or `HOME` are fine. Only `fail` lines count.

To remove the image afterwards:

```bash
docker rmi mc-ffmpeg51
```

Checked in J4 on the same base image without ffmpeg: the mount and the imports work, and the only
failures were "ffmpeg not found". Source: step 9 of `docs/phase0-handoff.md` and
`worker/test/untrusted.test.ts`.
