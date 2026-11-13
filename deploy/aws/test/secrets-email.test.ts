import { test } from "node:test";
import assert from "node:assert/strict";
import { GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { SendEmailCommand } from "@aws-sdk/client-sesv2";
import { awsSecretsAndEmail } from "../src/secrets-email.ts";
import { render as renderF } from "../src/email-templates.ts";
import { render as renderE } from "../../supabase/src/email-templates.ts";
import type { EmailTemplate } from "../src/core.ts";
import { FakeAws, awsError } from "./fake-aws.ts";

const DATA: Record<EmailTemplate, Record<string, string>> = {
  split_invitation: { releaseTitle: 'Blue "Night" <b>', artistName: "A & B", inviteCode: "CODE-123", expiresAt: "2026-11-27" },
  review_needs_changes: { releaseTitle: "Blue\r\nBcc: x@y", reason: "Fix the <cover>" },
  release_taken_down: { releaseTitle: "Blue", reason: "Rights claim" },
};

test("the templates render exactly as session E's, from the same data fields", () => {
  for (const [template, data] of Object.entries(DATA) as [EmailTemplate, Record<string, string>][]) {
    assert.deepEqual(renderF(template, data), renderE(template, data));
  }
});

test("values are escaped in HTML, subjects stay on one line, a missing field is refused", () => {
  const invite = renderF("split_invitation", DATA.split_invitation);
  assert.ok(invite.html.includes("&lt;b&gt;") && invite.html.includes("A &amp; B") && !invite.html.includes("<b>"));
  assert.ok(!/[\r\n]/.test(renderF("review_needs_changes", DATA.review_needs_changes).subject));
  assert.throws(() => renderF("split_invitation", { releaseTitle: "x", artistName: "y", inviteCode: "z" }), /needs expiresAt/);
  assert.throws(() => renderF("release_taken_down", { releaseTitle: "x", reason: "" }), /needs reason/);
});

function module(secrets = new FakeAws(), ses = new FakeAws(), now = () => 0) {
  return awsSecretsAndEmail({ secrets, ses, from: "Milk Crate <noreply@example.invalid>", now });
}

test("getSecret reads milk-crate/phase0/<NAME> from Secrets Manager, keeps it a few minutes, refuses bad names", async () => {
  let t = 0;
  const secrets = new FakeAws().on(GetSecretValueCommand, (input) => ({ SecretString: `value of ${input.SecretId}` }));
  const m = module(secrets, new FakeAws(), () => t);
  assert.equal(await m.getSecret("MC_CLOUDFRONT_PRIVATE_KEY"), "value of milk-crate/phase0/MC_CLOUDFRONT_PRIVATE_KEY");
  await m.getSecret("MC_CLOUDFRONT_PRIVATE_KEY");
  assert.equal(secrets.sent.length, 1, "cached");
  t = 6 * 60_000;
  await m.getSecret("MC_CLOUDFRONT_PRIVATE_KEY");
  assert.equal(secrets.sent.length, 2, "read again after 5 minutes");
  await assert.rejects(m.getSecret("../database"), /bad secret name/);
  await assert.rejects(m.getSecret("lower"), /bad secret name/);
  const missing = new FakeAws().on(GetSecretValueCommand, () => { throw awsError("ResourceNotFoundException"); });
  await assert.rejects(module(missing).getSecret("NOPE"), /secret NOPE is not set/);
});

test("sendTemplate sends through SES with text and HTML", async () => {
  const ses = new FakeAws().on(SendEmailCommand, () => ({ MessageId: "m" }));
  await module(new FakeAws(), ses).sendTemplate({ template: "release_taken_down", to: "artist@example.invalid", data: DATA.release_taken_down });
  const [input] = ses.inputs(SendEmailCommand);
  const expected = renderE("release_taken_down", DATA.release_taken_down);
  assert.equal(input.FromEmailAddress, "Milk Crate <noreply@example.invalid>");
  assert.deepEqual(input.Destination, { ToAddresses: ["artist@example.invalid"] });
  assert.equal(input.Content.Simple.Subject.Data, expected.subject);
  assert.equal(input.Content.Simple.Body.Text.Data, expected.text);
  assert.equal(input.Content.Simple.Body.Html.Data, expected.html);
});

test("sendTemplate refuses a bad address and a missing field before calling SES", async () => {
  const ses = new FakeAws();
  const m = module(new FakeAws(), ses);
  await assert.rejects(m.sendTemplate({ template: "release_taken_down", to: "a@b.c, x@y.z", data: DATA.release_taken_down }), /bad email/);
  await assert.rejects(m.sendTemplate({ template: "release_taken_down", to: "a@b.co", data: { releaseTitle: "x" } }), /needs reason/);
  assert.equal(ses.sent.length, 0);
});
