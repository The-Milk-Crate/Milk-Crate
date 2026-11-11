/**
 * Typed client for the Milk Crate API (release publishing and plays).
 * Types are generated from api/openapi.yaml: run `npm run api:client`. Do not edit schema.d.ts.
 * No screen calls this yet. The app keeps calling Supabase directly until Phase 1.
 */
import createClient from "openapi-fetch";
import type { components, paths } from "./schema";

export type { components, paths };
export type ReleaseState = components["schemas"]["ReleaseState"];
export type AccountType = components["schemas"]["AccountType"];
export type ApiError = components["schemas"]["Error"];

export function createApiClient(baseUrl: string, getToken: () => Promise<string | null>) {
  const client = createClient<paths>({ baseUrl });
  client.use({
    async onRequest({ request }) {
      const token = await getToken();
      if (token) request.headers.set("Authorization", `Bearer ${token}`);
      return request;
    },
  });
  return client;
}
