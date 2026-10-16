import { describe, expect, it } from "vitest";
import { tintScale } from "./settings";

describe("glass transparency", () => {
  it("is unchanged at the default and stays in a readable range", () => {
    expect(tintScale(50)).toBe(1);
    expect(tintScale(0)).toBeCloseTo(1.4);
    expect(tintScale(100)).toBeCloseTo(0.84);
    expect(tintScale(500)).toBeCloseTo(0.84);
  });
});
