import { beforeEach, describe, expect, it } from "vitest";
import { breachCount, clearSignInFailures, hasEmail, noteSignInFailure, passwordProblem, redactEmails, signInWait } from "./security";

describe("passwords", () => {
  it("needs 8+ characters, not common, not the email", () => {
    expect(passwordProblem("short")).toMatch(/8 characters/);
    expect(passwordProblem("password123")).toMatch(/easy to guess/);
    expect(passwordProblem("aaaaaaaaaa")).toMatch(/easy to guess/);
    expect(passwordProblem("bowenrocks!", "bowen@example.com")).toMatch(/email/);
    expect(passwordProblem("purple tractor lamp")).toBeNull();
  });
  it("only sends the first 5 characters of the hash and matches locally", async () => {
    let asked = "";
    // SHA-1("password") = 5BAA61E4C9B93F3F0682250B6CF8331B7EE68FD8
    const fake = (async (url: string) => { asked = url; return new Response("1E4C9B93F3F0682250B6CF8331B7EE68FD8:9545824\r\n0000000000000000000000000000000000A:0"); }) as typeof fetch;
    expect(await breachCount("password", fake)).toBe(9545824);
    expect(asked).toBe("https://api.pwnedpasswords.com/range/5BAA6");
    expect(await breachCount("something else", fake)).toBe(0);
    expect(await breachCount("x", (async () => { throw new Error("offline"); }) as typeof fetch)).toBe(0);
  });
});

describe("emails", () => {
  it("finds and hides addresses", () => {
    expect(hasEmail("DJ Bo")).toBe(false);
    expect(hasEmail("bo@x.co")).toBe(true);
    expect(redactEmails("User fan@example.com not found, cc a.b+c@mail.org")).toBe("User [email] not found, cc [email]");
  });
});

describe("sign-in throttle", () => {
  beforeEach(() => {
    const m = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), clear: () => m.clear() } });
  });
  it("waits after 5 misses, doubling", () => {
    const t = 1_000_000;
    for (let i = 0; i < 4; i++) noteSignInFailure("A@x.com", t);
    expect(signInWait("a@x.com", t)).toBe(0);
    noteSignInFailure("a@x.com", t);
    expect(signInWait("a@x.com", t)).toBe(30);
    noteSignInFailure("a@x.com", t);
    expect(signInWait("a@x.com", t)).toBe(60);
    clearSignInFailures("a@x.com");
    expect(signInWait("a@x.com", t)).toBe(0);
  });
});
