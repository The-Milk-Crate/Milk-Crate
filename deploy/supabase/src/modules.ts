import type { Modules } from "./core.ts";
import { required, type Env } from "./env.ts";
import { postgresDatabase, type ClosableDatabase } from "./database.ts";
import { supabaseIdentity } from "./identity.ts";
import { supabaseStorage } from "./storage.ts";
import { supabaseJobs, type ApplyJobResult } from "./jobs.ts";
import { flyMachines } from "./fly.ts";
import { supabaseSchedules } from "./schedules.ts";
import { supabaseSecretsAndEmail } from "./secrets-email.ts";
import { parseFileSize } from "./size.ts";

/**
 * Settings, all from the environment (Edge Function secrets, or Fly secrets for the worker).
 * See scripts/secrets.env.example. Supabase sets SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and
 * SUPABASE_DB_URL in Edge Functions by itself.
 *
 * The database role: the URL's user is `postgres`, the owner that applied db/migrations. It
 * keeps full access after session C's lock-down, and runs pg_cron. `service_role` cannot log
 * in to Postgres directly (it is the role the REST API switches to), so it is not an option
 * for a Postgres connection.
 */
export function createSupabaseModules(
  env: Env,
  extra: { applyJobResult?: ApplyJobResult; fetch?: typeof fetch; poolSize?: number } = {},
): Modules & { database: ClosableDatabase } {
  const supabaseUrl = required(env, "SUPABASE_URL");
  const serviceKey = required(env, "SUPABASE_SERVICE_ROLE_KEY");
  // MC_DB_URL: the pooler in transaction mode (port 6543) for Edge Functions.
  const database = postgresDatabase({
    url: env("MC_DB_URL") || required(env, "SUPABASE_DB_URL"),
    max: extra.poolSize,
  });
  const flyToken = env("FLY_API_TOKEN");
  const worker = flyToken
    ? flyMachines({
        app: required(env, "MC_FLY_APP"),
        token: flyToken,
        image: required(env, "MC_FLY_WORKER_IMAGE"),
        region: env("MC_FLY_REGION") || undefined,
        fetch: extra.fetch,
      })
    : undefined;
  const ttl = Number(env("MC_READ_TTL_SECONDS") || 600);
  return {
    database,
    identity: supabaseIdentity({
      supabaseUrl,
      legacyJwtSecret: env("MC_LEGACY_JWT_SECRET") || undefined,
      fetch: extra.fetch,
    }),
    storage: supabaseStorage({
      supabaseUrl,
      storageUrl: env("MC_STORAGE_URL") || undefined,
      serviceKey,
      publishableKey: env("MC_PUBLISHABLE_KEY") || undefined,
      readTtlSeconds: Number.isFinite(ttl) && ttl > 0 ? ttl : 600,
      fileSizeLimitBytes: parseFileSize(env("MC_FILE_SIZE_LIMIT")),
      fetch: extra.fetch,
    }),
    jobs: supabaseJobs({ database, worker, applyResult: extra.applyJobResult }),
    schedules: supabaseSchedules(database),
    secretsAndEmail: supabaseSecretsAndEmail({ env, from: env("MC_EMAIL_FROM") || "", fetch: extra.fetch }),
  };
}
