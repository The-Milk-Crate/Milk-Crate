// Small hand-written checks, written from api/openapi.yaml. core/ has no runtime dependencies,
// so no schema library. Each check throws the contract's 400 naming the field.
import { badRequest } from "./http.ts";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
// RFC 3339 date-time, as the contract's `format: date-time`.
const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;
// Simple and permissive: something@something.something, no spaces.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

/** Reads the body as one JSON object. */
export async function readJsonObject(request: Request): Promise<JsonObject> {
  let text: string;
  try {
    text = await request.text();
  } catch {
    throw badRequest("The request body could not be read.");
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw badRequest("The request body must be JSON.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw badRequest("The request body must be a JSON object.");
  }
  return value as JsonObject;
}

export function pathUuid(value: string | undefined, name: string): string {
  if (!isUuid(value)) throw badRequest(`${name} must be a UUID.`, { field: name });
  return value.toLowerCase();
}

export function uuidField(value: unknown, field: string): string {
  if (!isUuid(value)) throw badRequest(`${field} must be a UUID.`, { field });
  return value.toLowerCase();
}

export function stringField(value: unknown, field: string, min: number, max: number): string {
  if (typeof value !== "string") throw badRequest(`${field} must be text.`, { field });
  // Length in characters (code points), as JSON Schema counts it.
  const length = [...value].length;
  if (length < min || length > max) {
    throw badRequest(`${field} must be ${min} to ${max} characters.`, { field });
  }
  return value;
}

/** Text with something other than spaces in it. The database refuses a blank title or name. */
export function textField(value: unknown, field: string, min: number, max: number): string {
  const text = stringField(value, field, min, max);
  if (min > 0 && text.trim().length === 0) throw badRequest(`${field} cannot be blank.`, { field });
  return text;
}

export function integerField(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw badRequest(`${field} must be a whole number from ${min} to ${max}.`, { field });
  }
  return value;
}

export function enumField<T extends string>(value: unknown, field: string, allowed: readonly T[]): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw badRequest(`${field} must be one of: ${allowed.join(", ")}.`, { field });
  }
  return value as T;
}

export function isCalendarDate(value: string): boolean {
  const m = DATE.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d && y >= 1;
}

export function dateField(value: unknown, field: string): string {
  if (typeof value !== "string" || !isCalendarDate(value)) {
    throw badRequest(`${field} must be a date such as 2026-05-01.`, { field });
  }
  return value;
}

export function dateTimeField(value: unknown, field: string): string {
  const m = typeof value === "string" ? DATE_TIME.exec(value) : null;
  if (!m || !isCalendarDate(`${m[1]}-${m[2]}-${m[3]}`) || Number(m[4]) > 23 || Number(m[5]) > 59 || Number(m[6]) > 60) {
    throw badRequest(`${field} must be a date and time such as 2026-05-01T12:00:00Z.`, { field });
  }
  return value as string;
}

export function emailField(value: unknown, field: string): string {
  const text = stringField(value, field, 3, 320);
  if (!EMAIL.test(text)) throw badRequest(`${field} must be an email address.`, { field });
  return text;
}

export function arrayField(value: unknown, field: string, min: number, max: number): Json[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    throw badRequest(`${field} must be a list of ${min} to ${max} items.`, { field });
  }
  return value as Json[];
}

export function objectField(value: unknown, field: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw badRequest(`${field} must be an object.`, { field });
  }
  return value as JsonObject;
}

/** A share: 0 to 100 in steps of 0.01. Returned in hundredths, so sums are exact. */
export function percentField(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) {
    throw badRequest(`${field} must be a number from 0 to 100.`, { field });
  }
  const hundredths = Math.round(value * 100);
  if (Math.abs(hundredths - value * 100) > 1e-6) {
    throw badRequest(`${field} must have at most two decimal places.`, { field });
  }
  return hundredths;
}
