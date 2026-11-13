import { GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { SendEmailCommand } from "@aws-sdk/client-sesv2";
import type { EmailTemplate, SecretsAndEmail } from "./core.ts";
import { errorName, type Sender } from "./aws.ts";
import { render } from "./email-templates.ts";

const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,99}$/;
const EMAIL = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/;

export interface AwsSecretsAndEmailOptions {
  /** A Secrets Manager client. */
  secrets: Sender;
  /** An SES (v2) client. */
  ses: Sender;
  /** Secret names are looked up as <prefix><NAME>. Default `milk-crate/phase0/`. */
  prefix?: string;
  /** The From address, on the domain verified in SES. */
  from: string;
  /** An SES configuration set, if any. */
  configurationSet?: string;
  /** How long a secret is kept in memory, in ms. Default 5 minutes. */
  cacheMs?: number;
  now?: () => number;
}

/**
 * Secrets: AWS Secrets Manager, by name (`milk-crate/phase0/<NAME>`). Chosen over Parameter
 * Store because the RDS Data API needs the database login in Secrets Manager anyway, so one
 * service holds every secret, with one IAM rule. Kept in memory for a few minutes.
 * Email: SES (v2 SendEmail) with session E's three templates and the same data fields.
 */
export function awsSecretsAndEmail(options: AwsSecretsAndEmailOptions): SecretsAndEmail {
  const prefix = options.prefix ?? "milk-crate/phase0/";
  const cacheMs = options.cacheMs ?? 5 * 60_000;
  const now = options.now ?? Date.now;
  const cache = new Map<string, { value: string; at: number }>();

  async function getSecret(name: string): Promise<string> {
    if (!SECRET_NAME.test(name)) throw new Error(`bad secret name: ${name}`);
    const hit = cache.get(name);
    if (hit && now() - hit.at < cacheMs) return hit.value;
    let value: string | undefined;
    try {
      const out = await options.secrets.send(new GetSecretValueCommand({ SecretId: `${prefix}${name}` }));
      value = out.SecretString;
    } catch (error) {
      if (errorName(error) === "ResourceNotFoundException") throw new Error(`secret ${name} is not set`);
      throw error;
    }
    if (value === undefined || value === "") throw new Error(`secret ${name} is not set`);
    cache.set(name, { value, at: now() });
    return value;
  }

  return {
    getSecret,
    async sendTemplate(input: { template: EmailTemplate; to: string; data: Record<string, string> }): Promise<void> {
      if (!EMAIL.test(input.to)) throw new Error("bad email address");
      if (!options.from) throw new Error("no From address (MC_EMAIL_FROM)");
      const message = render(input.template, input.data);
      await options.ses.send(
        new SendEmailCommand({
          FromEmailAddress: options.from,
          Destination: { ToAddresses: [input.to] },
          ...(options.configurationSet ? { ConfigurationSetName: options.configurationSet } : {}),
          Content: {
            Simple: {
              Subject: { Data: message.subject, Charset: "UTF-8" },
              Body: { Text: { Data: message.text, Charset: "UTF-8" }, Html: { Data: message.html, Charset: "UTF-8" } },
            },
          },
        }),
      );
    },
  };
}
