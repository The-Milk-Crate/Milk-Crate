# Supabase stand-up: step by step

Written 25 November 2026. Tracker: `supabase-stand-up.xlsx` (or `.csv`) in this folder.

The stand-up is one script, `deploy/supabase/scripts/stand-up.sh`, run in WSL from
`/mnt/e/GitHub/Milk-Crate` on `milk-crate-backend-poc`. It stands up Phase 0 on a separate free
Supabase project and a Fly app. It has not been run for real yet. It holds no secrets: every
setting comes from your shell and two secrets files kept outside the repository.

## Before you start

You need three accounts and six tools. Check each tool in WSL before the first step.

**Accounts**

- **Supabase:** a new, separate free project for Phase 0, never the app's live project. Pushing
  `config.toml` replaces the project's auth settings, and the sign-in hook runs on every sign-in.
  Note its project ref, database password and region.
- **Fly.io:** an organization, and a token that may create apps and machines in it.
- **Resend:** an account with 2FA on, kept to you, and an API key with **sending access only**
  (security review L7). Resend needs a verified sending domain; see the open question below.

**Tools (in WSL)**

| Tool | Check | Expected |
| --- | --- | --- |
| Supabase CLI | `supabase --version` | `2.122.1` (any other version only warns; install with `npm install -g supabase@2.122.1`) |
| Docker Desktop, WSL integration on | `docker info` | No error. The script stops if Docker is not running. |
| psql | `psql --version` | 16 or newer |
| flyctl | `flyctl version` | Any recent version |
| Node | `node --version` | 22.18 or newer (`nvm use 22`) |
| npm | `npm --version` | Comes with Node |

**Open question:** there is no email domain yet (AWS uses `example.com`). The stand-up needs
`RESEND_API_KEY` and `MC_EMAIL_FROM`, but invitation emails cannot send until Resend has a
verified domain. Everything else works without email.

## The steps

Do one step at a time. Stop at any result that differs from "Expected" and bring the output to a
session. Never paste a password, key or token into a chat.

**Step 1. Make the Phase 0 Supabase project.** In the Supabase dashboard, choose New project, on
the Free plan, with a name such as `milk-crate-phase0`. Save the database password in your
password manager. Then note these four things:

- the project ref: the id in the project's address, `supabase.com/dashboard/project/<ref>`;
- the session pooler address: Connect, then Session pooler (port 5432);
- the publishable key and the secret key: Project Settings, then API Keys;
- a personal access token: your account menu, then Access Tokens.

Expected: a new, empty project. It is not the app's live project.

**Step 2. Make the Fly token.**

```bash
flyctl auth login
```

```bash
flyctl orgs list
```

Pick the organization and an app name, such as `milk-crate-phase0-worker`. Then make a token for
that organization (check the exact form with `flyctl tokens create org --help` first):

```bash
flyctl tokens create org <your-org>
```

Expected: a long token that starts with `FlyV1`. Save it in your password manager.

**Step 3. Make the two secrets files, outside the repository.**

```bash
mkdir -p ~/mc-secrets && chmod 700 ~/mc-secrets
```

```bash
cp /mnt/e/GitHub/Milk-Crate/deploy/supabase/scripts/secrets.env.example ~/mc-secrets/supabase.secrets.env
```

```bash
cp /mnt/e/GitHub/Milk-Crate/deploy/supabase/scripts/fly-secrets.env.example ~/mc-secrets/fly.secrets.env
```

Fill in both files in an editor. Each line says what goes there. Three lines must match your shell
exactly, or the script stops:

- `MC_FILE_SIZE_LIMIT=50MiB` (the Free plan's cap);
- `MC_FLY_WORKER_IMAGE=registry.fly.io/<app name>:phase0`;
- `RESEND_API_KEY`: the sending-only key.

Expected: two files under `~/mc-secrets`, none inside the repository.

**Step 4. Set the settings in your shell.** Type the secrets with `read -rs`, so they stay out of
your shell history. Each `read` waits for you to paste the value and press Enter; nothing shows.

```bash
read -rs SUPABASE_ACCESS_TOKEN && export SUPABASE_ACCESS_TOKEN
```

```bash
read -rs SUPABASE_DB_PASSWORD && export SUPABASE_DB_PASSWORD PGPASSWORD="$SUPABASE_DB_PASSWORD"
```

```bash
read -rs FLY_API_TOKEN && export FLY_API_TOKEN
```

Then the settings that are not secret (put in your own values):

```bash
export MC_SUPABASE_PROJECT_REF=<ref> MC_DB_URL='postgresql://postgres.<ref>@aws-0-<region>.pooler.supabase.com:5432/postgres' MC_SITE_URL=http://localhost:1420 MC_SECRETS_FILE=~/mc-secrets/supabase.secrets.env MC_FLY_SECRETS_FILE=~/mc-secrets/fly.secrets.env MC_FLY_APP=<app name> MC_FLY_ORG=<your-org> MC_FLY_REGION=iad MC_FILE_SIZE_LIMIT=50MiB
```

Expected: no output. `MC_DB_URL` has no password in it; the script refuses one that does.
`MC_SITE_URL` is a guess for the desktop app's local address; see the open question below.

**Step 5. Bring your checkout up to date.**

```bash
cd /mnt/e/GitHub/Milk-Crate && git checkout milk-crate-backend-poc && git pull
```

Expected: `git log --oneline -1` shows the merge of #48 (J4's handoff) or later.

**Step 6. Run the stand-up.**

```bash
bash deploy/supabase/scripts/stand-up.sh
```

It prints what it will change and asks you to type the project ref again. Then it runs seven
stages, each starting with `==`:

| Stage | What it does | Expected |
| --- | --- | --- |
| `== 2. link` | Links the CLI to the project | `Finished supabase link.` |
| `== 3. database` | Applies the app's SQL, `db/migrations/`, `db/supabase/` and `deploy/supabase/sql/` in one transaction | No error. A failure changes nothing. |
| `== 4. auth and storage settings` | Pushes `config.toml`: sign-in hook, token life, password rules, file size limit | It may ask to confirm the changes: answer yes. |
| `== 5. Edge Function secrets` | Sets the secrets from your file | `Finished supabase secrets set.` |
| `== 6. Edge Functions` | Copies `core/src/`, bundles in Docker, deploys `api` | `deployed 1 Edge Functions` |
| `== 7. Fly worker` | Creates the app, sets its secrets, builds and pushes the image (with J4's fix), makes the hourly sweep machine | The image push finishes; one machine named `sweep`. |
| `== 8. checks` | Runs `confirm.sh` | `ok - the Phase 0 Supabase deployment checks passed` |

The script is safe to run again after a fix. Each stage skips or repeats what is already done.

**Open question:** `MC_SITE_URL` is Auth's site address, used in auth emails. The repository does
not say what it should be for Phase 0. `http://localhost:1420` is Tauri's usual local address;
confirm or pick another.

## Checks after the stand-up, and if something fails

The stand-up is done when `confirm.sh` prints `ok - the Phase 0 Supabase deployment checks passed`.
You can run the checks again at any time. They only read and change nothing.

```bash
bash deploy/supabase/scripts/confirm.sh
```

Otherwise it prints one `problem - ...` line each. The common ones:

| Problem line | What it means | What to do |
| --- | --- | --- |
| `db/migrations are not applied` (or `db/supabase`, `deploy/supabase/sql`) | Stage 3 did not finish | Run the stand-up again; bring the stage 3 error to a session |
| `pg_cron is not enabled` | The extension is off | Turn on pg_cron under Database, Extensions, then run the stand-up again |
| `the custom access token hook is off` | Stage 4 did not push | Run the stand-up again and answer yes at the `config push` prompt |
| `bucket mc-masters limit is ..., want ...` | `MC_FILE_SIZE_LIMIT` differs between shell, file and project | Set `50MiB` in all three places, then run the stand-up again |
| `... can reach ...` or `row level security is off on ...` | A table is open to clients | Stop. Do not use the project. Bring it to a session |
| `Fly app ... returned 401` (or 404) | Wrong Fly token or app name | Check `FLY_API_TOKEN` and `MC_FLY_APP`, then run again |

**When it passes**

- [ ] Tick the Resend item under "Still open" in `docs/phase0-handoff.md`: sending-only key, 2FA
  on, retention shortened if offered.
- [ ] Note the run's date and commit for the handoff (the next session adds it under "Done").
- [ ] Make test accounts in the project (it starts with none): one artist and one admin.

**To undo it**

This keeps the project and its tables, and removes the functions, schedules, Phase 0 buckets and
the Fly app:

```bash
bash deploy/supabase/scripts/tear-down.sh
```

This also deletes the whole Phase 0 project:

```bash
bash deploy/supabase/scripts/tear-down.sh --delete-project
```

The tear-down also needs `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in your shell (the secret
key, typed with `read -rs`).

Source: `deploy/supabase/README.md` and the comments at the top of `stand-up.sh`, `confirm.sh` and
`tear-down.sh`, on `milk-crate-backend-poc` as of 25 November 2026.
