export type EmailTemplate = "split_invitation" | "review_needs_changes" | "release_taken_down";

/** Get a secret by name, send this template. */
export interface SecretsAndEmail {
  getSecret(name: string): Promise<string>;
  sendTemplate(input: {
    template: EmailTemplate;
    to: string;
    data: Record<string, string>;
  }): Promise<void>;
}
