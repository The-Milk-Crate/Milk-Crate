import type { Database, Infrastructure } from "./core.ts";
import { DEFAULT_BUCKETS, COVER_MAX_BYTES, MASTER_MAX_BYTES } from "./storage.ts";

export const HOOK_URI = "pg-functions://postgres/public/api_access_token_hook";
const CLIENT_FUNCTIONS = ["api_client_get_invitation", "api_client_respond_to_invite"];

export interface ConfirmOptions {
  /** The server connection (the owner role). */
  database: Database;
  projectRef: string;
  /** A Supabase personal access token, for the Management API. Read from the environment. */
  accessToken: string;
  /** The Fly app and a token for it. */
  flyApp: string;
  flyToken: string;
  managementApi?: string;
  flyApi?: string;
  fetch?: typeof fetch;
}

/** Checks a stood-up deployment. Returns every problem found, in plain words. */
export async function confirmDeployment(options: ConfirmOptions): Promise<{ ok: boolean; problems: string[] }> {
  const problems: string[] = [];
  const db = options.database;
  const doFetch = options.fetch ?? fetch;
  const check = async (what: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (error) {
      problems.push(`${what}: ${(error as Error).message}`);
    }
  };

  await check("database", async () => {
    const [objects] = await db.query<Record<string, boolean>>(
      `select to_regclass('public.api_releases') is not null as migrations,
              to_regclass('public.api_schedules') is not null as schedules,
              to_regprocedure('public.api_access_token_hook(jsonb)') is not null as hook,
              to_regprocedure('public.api_client_get_invitation(uuid, uuid, text)') is not null as invitee,
              exists (select 1 from pg_namespace where nspname = 'cron') as cron`,
    );
    if (!objects.migrations) problems.push("db/migrations are not applied");
    if (!objects.hook || !objects.invitee) problems.push("db/supabase is not applied");
    if (!objects.schedules) problems.push("deploy/supabase/sql is not applied");
    if (!objects.cron) problems.push("pg_cron is not enabled");
    if (!objects.migrations || !objects.hook) return;

    const [hook] = await db.query<{ ok: boolean }>(
      "select has_function_privilege('supabase_auth_admin', 'public.api_access_token_hook(jsonb)', 'execute') as ok",
    );
    if (!hook.ok) problems.push("supabase_auth_admin cannot run the access token hook");

    const noRls = await db.query<{ name: string }>(
      `select c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relname like 'api\\_%' and c.relkind in ('r', 'p')
         and not c.relrowsecurity order by 1`,
    );
    for (const r of noRls) problems.push(`row level security is off on ${r.name}`);

    const openTables = await db.query<{ name: string; role: string }>(
      `select c.relname as name, r.role from pg_class c join pg_namespace n on n.oid = c.relnamespace
       cross join (values ('anon'), ('authenticated')) r(role)
       where n.nspname = 'public' and c.relname like 'api\\_%' and c.relkind in ('r', 'p', 'v', 'm')
         and has_table_privilege(r.role, c.oid, 'select, insert, update, delete') order by 1, 2`,
    );
    for (const r of openTables) problems.push(`${r.role} can reach ${r.name}`);

    const openFunctions = await db.query<{ name: string; role: string }>(
      `select p.proname as name, r.role from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       cross join (values ('anon'), ('authenticated')) r(role)
       where n.nspname = 'public' and p.proname like 'api\\_%' and p.prokind = 'f'
         and has_function_privilege(r.role, p.oid, 'execute')
         and not (r.role = 'authenticated' and p.proname in (select jsonb_array_elements_text($1::jsonb))) order by 1, 2`,
      [CLIENT_FUNCTIONS],
    );
    for (const r of openFunctions) problems.push(`${r.role} can run ${r.name}`);

    if (objects.cron) {
      const [tz] = await db.query<{ tz: string | null }>("select current_setting('cron.timezone', true) as tz");
      if (tz.tz && !["GMT", "UTC", "Etc/UTC"].includes(tz.tz)) problems.push(`cron.timezone is ${tz.tz}, not UTC`);
    }

    const buckets = await db.query<{ id: string; public: boolean; file_size_limit: string | null }>(
      "select id, public, file_size_limit::text as file_size_limit from storage.buckets where id in (select jsonb_array_elements_text($1::jsonb))",
      [Object.values(DEFAULT_BUCKETS)],
    );
    const want: Record<string, number | null> = {
      [DEFAULT_BUCKETS.masters]: MASTER_MAX_BYTES,
      [DEFAULT_BUCKETS.art]: COVER_MAX_BYTES,
      [DEFAULT_BUCKETS.streams]: null,
    };
    for (const [id, limit] of Object.entries(want)) {
      const b = buckets.find((x) => x.id === id);
      if (!b) problems.push(`bucket ${id} is missing`);
      else if (b.public) problems.push(`bucket ${id} is public`);
      else if (limit !== null && Number(b.file_size_limit) !== limit) {
        problems.push(`bucket ${id} limit is ${b.file_size_limit}, want ${limit}`);
      }
    }
  });

  const management = (options.managementApi ?? "https://api.supabase.com").replace(/\/+$/, "");
  const mgmt = async (path: string) => {
    const response = await doFetch(`${management}/v1/projects/${encodeURIComponent(options.projectRef)}${path}`, {
      headers: { authorization: `Bearer ${options.accessToken}` },
    });
    if (!response.ok) throw new Error(`Management API ${path} returned ${response.status}`);
    return (await response.json()) as Record<string, unknown>;
  };

  await check("auth", async () => {
    const auth = await mgmt("/config/auth");
    if (auth.hook_custom_access_token_enabled !== true) problems.push("the custom access token hook is off");
    if (auth.hook_custom_access_token_uri !== HOOK_URI) {
      problems.push(`the access token hook points at ${String(auth.hook_custom_access_token_uri)}`);
    }
    if (auth.jwt_exp !== undefined && auth.jwt_exp !== 3600) {
      problems.push(`token life is ${String(auth.jwt_exp)} seconds, expected 3600`);
    }
  });

  await check("storage", async () => {
    const storage = await mgmt("/config/storage");
    const limit = Number(storage.fileSizeLimit);
    if (!(limit >= MASTER_MAX_BYTES)) {
      problems.push(`the project's file size limit is ${limit} bytes; 5 GiB masters need 5368709120 (Pro plan or higher)`);
    }
  });

  await check("fly", async () => {
    const base = (options.flyApi ?? "https://api.machines.dev").replace(/\/+$/, "");
    const response = await doFetch(`${base}/v1/apps/${encodeURIComponent(options.flyApp)}`, {
      headers: { authorization: `Bearer ${options.flyToken}` },
    });
    if (!response.ok) problems.push(`Fly app ${options.flyApp} returned ${response.status}`);
  });

  return { ok: problems.length === 0, problems };
}

/** Runs a script with the caller's environment. Node's child_process in scripts/infrastructure.ts. */
export type RunScript = (script: string, args: string[]) => Promise<void>;

/** `Infrastructure`: the stand-up and tear-down scripts, and the checks above. */
export function supabaseInfrastructure(options: {
  run: RunScript;
  confirm: () => Promise<{ ok: boolean; problems: string[] }>;
  tearDownArgs?: string[];
}): Infrastructure {
  return {
    standUp: () => options.run("scripts/stand-up.sh", []),
    confirm: options.confirm,
    tearDown: () => options.run("scripts/tear-down.sh", options.tearDownArgs ?? []),
  };
}
