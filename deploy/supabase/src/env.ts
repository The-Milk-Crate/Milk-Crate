/** Reads a setting or secret by name. Deno.env.get in Edge Functions, process.env in the worker. */
export type Env = (name: string) => string | undefined;

export function required(env: Env, name: string): string {
  const value = env(name);
  if (value === undefined || value === "") throw new Error(`${name} is not set`);
  return value;
}

/** The headers Supabase's REST services take for the server's secret key. */
export function serviceHeaders(serviceKey: string): Record<string, string> {
  // A legacy service_role key is a JWT and also goes in Authorization. A new `sb_secret_` key
  // goes only in `apikey`: the gateway turns it into a short-lived token itself.
  const isJwt = serviceKey.split(".").length === 3;
  return isJwt ? { apikey: serviceKey, authorization: `Bearer ${serviceKey}` } : { apikey: serviceKey };
}
