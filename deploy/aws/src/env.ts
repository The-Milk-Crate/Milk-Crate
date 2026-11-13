/** Reads a setting by name: process.env in Lambda and on Fargate. */
export type Env = (name: string) => string | undefined;

export function required(env: Env, name: string): string {
  const value = env(name);
  if (value === undefined || value === "") throw new Error(`${name} is not set`);
  return value;
}

/** A comma-separated list setting, such as subnets. */
export function list(env: Env, name: string): string[] {
  return required(env, name).split(",").map((s) => s.trim()).filter(Boolean);
}
