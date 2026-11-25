# worker/: the processing step (session H)

What happens to a release's masters while it is `processing`, written once for both workers:
Fly Machines on Supabase (`deploy/supabase/worker/`) and Fargate on AWS (`deploy/aws/worker/`).
Each platform's `worker/main.ts` passes `makeProcessRelease({ database, storage })` to its
skeleton (`runOneJob`), which claims the job first and reports what the step returns through
session G's `makeApplyJobResult`. The step never moves a release's state itself.

## What it does, per track

1. Streams the master once (`ObjectStorage.read`) to a temp file, hashing it on the way, and
   compares the SHA-256 with `api_tracks.master_sha256` (what the client sent at confirm).
2. Checks what the file really is with ffprobe, read only as the declared format: the container and codec must match the
   declared format (WAV or AIFF holding PCM, or FLAC), it must have an audio stream, and its
   sample rate must be readable.
3. Decodes it all the way through with ffmpeg into one 320 kbps MP3 (libmp3lame, 44.1 kHz
   stereo, no metadata), as the desktop app makes. Any error ffmpeg logs, or fewer samples than
   the header declares, fails the track as damaged. For WAV the declared length is read from the
   header's `data` chunk (or `ds64` in RF64), because ffprobe reports only what the file holds.
   A file whose length can't be read fails too. A silent track passes.
4. Writes the copy to `streams/{artist}/{release}/{track}/mp3-320.mp3` (`ObjectStorage.put`,
   `audio/mpeg`). The master is never written.

When every track passes, one transaction records `stream_key`, `duration_ms` and
`sample_rate_hz` on each track, but only while the release is still `processing`, this job is
its newest, and each master is still the one that was hashed. The first failing track stops the
job, and its plain-words reason is the release's reason. Whenever nothing is recorded (a
failure, a crash, or the release moved on, such as a takedown during the job), the copies this
job wrote are deleted. Two cases keep them: a newer job exists (it owns those keys), or the
track has a copy an earlier job recorded. Temp files are removed either way. A retried job
writes the same keys and gives the same result.

Masters are untrusted. ffprobe and ffmpeg get `-f wav|aiff|flac` (the declared format, so no
format guessing: a playlist or concat file is not opened as one) and `-protocol_whitelist file`
before the input, and run with only `PATH` in their environment (no database password, service
key or cloud credentials). ffmpeg's FLAC reader does not check the file's first bytes, so the
step checks the `fLaC` marker itself (after any ID3v2 tag). Security review, M4.

The words the artist reads are in `src/words.ts`.

## How it reaches the images

`deploy/*/scripts/copy-core.sh` copies `worker/src/` into that platform's build folder as
`_worker/` (not committed), next to `_core/`. Each platform keeps its own `worker/Dockerfile`.
Both use the same pinned base image and install ffmpeg with the same line, and
`test/images.test.ts` fails if they drift apart. `src/types.ts` writes out the few shapes the
step needs from core's `Database` and `ObjectStorage`, so this folder imports nothing outside
itself.

## Tests

```bash
bash worker/test/run.sh
```

It installs the packages of `worker/`, `deploy/supabase/` and `deploy/aws/` if needed, runs both
copy scripts, type-checks, starts a throwaway PostgreSQL 16, applies `db/migrations/`, then runs:

- `process.test.ts`: each format, the wrong format, truncated (also a WAV cut on a packet
  boundary), empty, no samples, silent (it passes), valid edge cases (24-bit, RF64, AIFF-C, a
  tag that reads `[error]`), a wrong SHA-256, a missing master, one bad track among good ones,
  a storage failure part way, a retried job, a stale job, a takedown during the job, cleanup
  after failures;
- `untrusted.test.ts`: an HLS playlist and an `ffconcat` file pointing at a local HTTP server,
  saved as a WAV, fail as the wrong format and the server gets no request; the tools get only
  `PATH` (fakes that record their environment) and still process a WAV, AIFF and FLAC; a FLAC
  with an ID3v2 tag in front passes;
- `platforms.test.ts`: one run through each platform's skeleton with its storage module over
  its fake (E's Supabase Storage fake; S3 at the SDK edge with F's Data API stand-in), ending in
  `awaiting_splits` or `failed`;
- `images.test.ts`: the two Dockerfiles, copy scripts and `main.ts` files carry the step the
  same way.

Needs Node 22.18 or newer, ffmpeg and ffprobe on PATH, and PostgreSQL 16. Audio is generated
with ffmpeg at test time; no audio files are committed. CI job: `worker-processing`.

The slow test (not run by default) streams a 2 GB WAV through and checks memory stays small:

```bash
MC_SLOW=1 bash worker/test/run.sh
```

Measured here (4 cores, ffmpeg 6.1): 2 GB WAV (3 h 9 min of audio) in 197 s, about 58× real
time. The MP3 was 433 MiB. Node's memory stayed at about 100 MiB and ffmpeg's peaked at 50 MiB.
