import type { EmailTemplate, SecretsAndEmail } from "./core.ts";
import type { Env } from "./env.ts";
import { render } from "./email-templates.ts";

const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,99}$/;
const EMAIL = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/;

export interface SupabaseSecretsAndEmailOptions {
  /** Edge Function secrets are environment variables: Deno.env.get. */
  env: Env;
  /** The From address, on a domain verified with Resend. */
  from: string;
  /** The secret that holds the Resend API key. */
  apiKeySecret?: string;
  apiBase?: string;
  fetch?: typeof fetch;
}

/**
 * Secrets: Edge Function secrets, read by name. Email: Resend's HTTP API (free plan: 3,000 a
 * month, 100 a day, one verified domain). Edge Functions cannot open SMTP ports 25 or 587,
 * and Supabase Auth's email sends only its own auth emails, so an HTTP provider is needed.
 */
export function supabaseSecretsAndEmail(options: SupabaseSecretsAndEmailOptions): SecretsAndEmail {
  const doFetch = options.fetch ?? fetch;
  const base = (options.apiBase ?? "https://api.resend.com").replace(/\/+$/, "");
  const getSecret = async (name: string): Promise<string> => {
    if (!SECRET_NAME.test(name)) throw new Error(`bad secret name: ${name}`);
    const value = options.env(name);
    if (value === undefined || value === "") throw new Error(`secret ${name} is not set`);
    return value;
  };
  return {
    getSecret,
    async sendTemplate(input: { template: EmailTemplate; to: string; data: Record<string, string> }): Promise<void> {
      if (!EMAIL.test(input.to)) throw new Error("bad email address");
      const message = render(input.template, input.data);
      const key = await getSecret(options.apiKeySecret ?? "RESEND_API_KEY");
      const response = await doFetch(`${base}/emails`, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({ from: options.from, to: [input.to], ...message }),
      });
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(`sending ${input.template} failed (${response.status}): ${text.slice(0, 200)}`);
      }
    },
  };
}
