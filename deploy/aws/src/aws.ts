/**
 * The one thing every module needs from an AWS SDK v3 client: `send(command)`. Modules take a
 * client (or a test stand-in with the same `send`) instead of making their own, so tests mock
 * each service at its SDK edge.
 */
export interface Sender {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  send(command: any): Promise<any>;
}

/** The AWS SDK error name, such as `NoSuchKey` or `ConflictException`. */
export function errorName(error: unknown): string {
  const e = error as { name?: string; Code?: string; code?: string } | null;
  return e?.name ?? e?.Code ?? e?.code ?? "";
}

/** The HTTP status the AWS SDK error carries, if any. */
export function errorStatus(error: unknown): number | undefined {
  return (error as { $metadata?: { httpStatusCode?: number } } | null)?.$metadata?.httpStatusCode;
}
