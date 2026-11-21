// The contract (api/openapi.yaml), read at run time: every operation with its route,
// `x-account-types` and `x-state-moves`, and a small checker for response bodies against the
// contract's schemas (the parts the contract uses: $ref, type, required, properties, items,
// enum, const, oneOf with a discriminator, allOf, and the uuid, date and date-time formats).
import { readFileSync } from "node:fs";
import { parse } from "yaml";

export const CONTRACT_PATH = new URL("../../../api/openapi.yaml", import.meta.url);

type Schema = Record<string, any>;

export interface ContractOperation {
  operationId: string;
  method: string;
  /** The contract's path, such as /v1/releases/{releaseId}. */
  path: string;
  accountTypes: string[];
  stateMoves: string[];
  /** Status (as text) to response schema, or null for a response with no body. */
  responses: Record<string, Schema | null>;
  /** The JSON request body schema, if any. */
  requestBody: Schema | null;
}

export interface Contract {
  doc: Schema;
  operations: Record<string, ContractOperation>;
  accountTypes: string[];
  releaseStates: string[];
}

let cached: Contract | undefined;

export function loadContract(): Contract {
  if (cached) return cached;
  const doc = parse(readFileSync(CONTRACT_PATH, "utf8")) as Schema;
  const operations: Record<string, ContractOperation> = {};
  for (const [path, item] of Object.entries<Schema>(doc.paths)) {
    for (const method of ["get", "post", "put", "patch", "delete"]) {
      const op = item[method];
      if (!op) continue;
      const responses: Record<string, Schema | null> = {};
      for (const [status, r] of Object.entries<Schema>(op.responses ?? {})) {
        const resolved = r.$ref ? resolveRef(doc, r.$ref) : r;
        responses[status] = resolved.content?.["application/json"]?.schema ?? null;
      }
      operations[op.operationId] = {
        operationId: op.operationId,
        method: method.toUpperCase(),
        path,
        accountTypes: op["x-account-types"] ?? [],
        stateMoves: op["x-state-moves"] ?? [],
        responses,
        requestBody: op.requestBody?.content?.["application/json"]?.schema ?? null,
      };
    }
  }
  cached = {
    doc,
    operations,
    accountTypes: doc.components.schemas.AccountType.enum,
    releaseStates: doc.components.schemas.ReleaseState.enum,
  };
  return cached;
}

function resolveRef(doc: Schema, ref: string): Schema {
  if (!ref.startsWith("#/")) throw new Error(`only local $ref: ${ref}`);
  let at: any = doc;
  for (const part of ref.slice(2).split("/")) at = at?.[part];
  if (!at) throw new Error(`no ${ref} in the contract`);
  return at;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * Problems with `value` against `schema`, as "path: what" strings. Empty means it fits.
 * Extra properties are allowed unless the schema says otherwise (the contract never does).
 */
export function checkSchema(schema: Schema, value: unknown, at = "$"): string[] {
  const doc = loadContract().doc;
  const s = schema.$ref ? resolveRef(doc, schema.$ref) : schema;
  const out: string[] = [];

  if (s.allOf) {
    for (const part of s.allOf) out.push(...checkSchema(part, value, at));
  }
  if (s.oneOf) {
    const prop = s.discriminator?.propertyName;
    if (prop) {
      const tag = (value as Record<string, unknown> | null)?.[prop];
      const ref = typeof tag === "string" ? s.discriminator.mapping?.[tag] : undefined;
      if (!ref) return [`${at}: ${prop} is ${JSON.stringify(tag)}, not one of ${Object.keys(s.discriminator.mapping).join(", ")}`];
      out.push(...checkSchema({ $ref: ref }, value, at));
    } else {
      const fits = s.oneOf.filter((b: Schema) => checkSchema(b, value, at).length === 0).length;
      if (fits !== 1) out.push(`${at}: fits ${fits} branches of oneOf, not 1`);
    }
  }
  if (s.const !== undefined && value !== s.const) out.push(`${at}: is ${JSON.stringify(value)}, not ${JSON.stringify(s.const)}`);
  if (s.enum && !s.enum.includes(value)) out.push(`${at}: ${JSON.stringify(value)} is not one of ${s.enum.join(", ")}`);

  const type = s.type;
  if (type) {
    const ok =
      type === "object" ? typeof value === "object" && value !== null && !Array.isArray(value)
      : type === "array" ? Array.isArray(value)
      : type === "integer" ? Number.isInteger(value)
      : type === "number" ? typeof value === "number" && Number.isFinite(value)
      : type === "string" ? typeof value === "string"
      : type === "boolean" ? typeof value === "boolean"
      : true;
    if (!ok) return [...out, `${at}: is ${describe(value)}, not ${type}`];
  }
  if (typeof value === "string") {
    if (s.format === "uuid" && !UUID.test(value)) out.push(`${at}: not a uuid`);
    if (s.format === "date" && !DATE.test(value)) out.push(`${at}: not a date`);
    if (s.format === "date-time" && !DATE_TIME.test(value)) out.push(`${at}: not a date-time`);
    if (s.format === "uri") {
      try { new URL(value); } catch { out.push(`${at}: not a URI`); }
    }
    if (s.pattern && !new RegExp(s.pattern).test(value)) out.push(`${at}: does not match ${s.pattern}`);
  }
  if (typeof value === "number") {
    if (s.minimum !== undefined && value < s.minimum) out.push(`${at}: below ${s.minimum}`);
    if (s.maximum !== undefined && value > s.maximum) out.push(`${at}: above ${s.maximum}`);
  }
  if (Array.isArray(value) && s.items) {
    value.forEach((v, i) => out.push(...checkSchema(s.items, v, `${at}[${i}]`)));
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    for (const name of s.required ?? []) if (!(name in obj)) out.push(`${at}.${name}: missing`);
    for (const [name, sub] of Object.entries<Schema>(s.properties ?? {})) {
      if (name in obj) out.push(...checkSchema(sub, obj[name], `${at}.${name}`));
    }
    if (s.additionalProperties && typeof s.additionalProperties === "object") {
      for (const [name, v] of Object.entries(obj)) {
        if (!(name in (s.properties ?? {}))) out.push(...checkSchema(s.additionalProperties, v, `${at}.${name}`));
      }
    }
  }
  return out;
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return typeof value;
}

/** Problems with a response against the contract's schema for that operation and status. */
export function checkResponse(operationId: string, status: number, body: unknown): string[] {
  const op = loadContract().operations[operationId];
  if (!op) return [`no operation ${operationId} in the contract`];
  if (!(String(status) in op.responses)) return [`${operationId} has no ${status} response in the contract`];
  const schema = op.responses[String(status)];
  if (!schema) return body === null || body === undefined ? [] : [`${operationId} ${status} has no body in the contract`];
  return checkSchema(schema, body);
}
