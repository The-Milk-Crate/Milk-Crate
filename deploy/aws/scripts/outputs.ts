// Reads the stack's outputs (MC_OUTPUTS_FILE, written by the stand-up) for the node scripts.
import { readFileSync } from "node:fs";

export type Outputs = Record<string, string>;

export function readOutputs(): Outputs {
  const file = process.env.MC_OUTPUTS_FILE;
  if (!file) throw new Error("MC_OUTPUTS_FILE is not set");
  return JSON.parse(readFileSync(file, "utf8")) as Outputs;
}

export function get(outputs: Outputs, name: string): string {
  const value = outputs[name];
  if (!value) throw new Error(`the stack has no output ${name}; run the stand-up again`);
  return value;
}

export function region(): string {
  const r = process.env.AWS_REGION;
  if (!r) throw new Error("AWS_REGION is not set");
  return r;
}
