// A copy of session E's templates (deploy/supabase/src/email-templates.ts), so both deployments
// send the same words from the same data. A test checks the two render the same.
import type { EmailTemplate } from "./core.ts";

/**
 * The three templates in secrets-email.ts. Each lists the `data` fields it needs; session G
 * passes them. Plain words. Values are escaped in the HTML part.
 */
export const TEMPLATES: Record<
  EmailTemplate,
  { needs: string[]; subject: (d: Record<string, string>) => string; text: (d: Record<string, string>) => string }
> = {
  split_invitation: {
    needs: ["releaseTitle", "artistName", "inviteCode", "expiresAt"],
    subject: (d) => `${d.artistName} invited you to a split on "${d.releaseTitle}"`,
    text: (d) =>
      [
        `${d.artistName} listed you as a rights holder on "${d.releaseTitle}" on Milk Crate.`,
        "",
        `Your invite code: ${d.inviteCode}`,
        "",
        "Sign in to Milk Crate and enter the code to see your share, then accept or decline.",
        `The code works once and expires on ${d.expiresAt}.`,
        "If you did not expect this, you can ignore this email.",
      ].join("\n"),
  },
  review_needs_changes: {
    needs: ["releaseTitle", "reason"],
    subject: (d) => `"${d.releaseTitle}" needs changes`,
    text: (d) =>
      [
        `A reviewer looked at "${d.releaseTitle}" and asked for changes:`,
        "",
        d.reason,
        "",
        "Open the release in Milk Crate to make them, then submit it again.",
      ].join("\n"),
  },
  release_taken_down: {
    needs: ["releaseTitle", "reason"],
    subject: (d) => `"${d.releaseTitle}" was taken down`,
    text: (d) =>
      [`"${d.releaseTitle}" was taken down from Milk Crate.`, "", `Reason: ${d.reason}`].join("\n"),
  },
};

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export function render(template: EmailTemplate, data: Record<string, string>) {
  const t = TEMPLATES[template];
  if (!t) throw new Error(`no email template ${template}`);
  const missing = t.needs.filter((k) => typeof data[k] !== "string" || data[k] === "");
  if (missing.length) throw new Error(`${template} needs ${missing.join(", ")}`);
  const text = t.text(data);
  // Headers cannot hold line breaks.
  const subject = t.subject(data).replace(/[\r\n]+/g, " ").slice(0, 200);
  const html = `<div style="font-family:sans-serif;white-space:pre-wrap">${escapeHtml(text)}</div>`;
  return { subject, text, html };
}
