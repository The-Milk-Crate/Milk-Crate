import { describe, expect, it } from "vitest";
import { updateErrorText } from "./updater";

describe("updateErrorText", () => {
  it("shows Tauri's plain-text errors instead of 'undefined'", () => {
    expect(updateErrorText("something odd happened")).toBe("The update didn't install: something odd happened");
    expect(updateErrorText(new Error("boom"))).toContain("boom");
    expect(updateErrorText(undefined)).not.toContain("undefined");
  });
  it("explains the common causes", () => {
    expect(updateErrorText("Read-only file system (os error 30)")).toMatch(/Applications folder/);
    expect(updateErrorText("Permission denied (os error 13)")).toMatch(/Permission denied/);
    expect(updateErrorText("signature verification failed")).toMatch(/security check/);
    expect(updateErrorText("error sending request: connection timed out")).toMatch(/internet connection/);
  });
});

describe("UpdateBlocked", () => {
  it("shows its instructions as they are", async () => {
    const { UpdateBlocked } = await import("./updater");
    expect(updateErrorText(new UpdateBlocked("Do this."))).toBe("Do this.");
  });
});
