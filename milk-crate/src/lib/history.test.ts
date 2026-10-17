import { describe, expect, it } from "vitest";
import { agoLabel, dayLabel, mergeHistory } from "./history";

describe("listening history", () => {
  it("merges the account's plays with this computer's own files, newest first", () => {
    const account = [{ trackId: "a", releaseId: "r", at: 300 }, { trackId: "b", releaseId: "r", at: 100 }];
    const local = [{ trackId: "local:x", releaseId: "", at: 200 }, { trackId: "a", releaseId: "r", at: 300 }];
    expect(mergeHistory(account, local).map((h) => h.trackId)).toEqual(["a", "local:x", "b"]);
  });
  it("labels days and times", () => {
    const now = new Date(2026, 9, 17, 15, 0).getTime();
    expect(dayLabel(now - 60_000, now)).toBe("Today");
    expect(dayLabel(new Date(2026, 9, 16, 23, 0).getTime(), now)).toBe("Yesterday");
    expect(dayLabel(new Date(2026, 9, 1).getTime(), now)).toBe("Oct 1");
    expect(agoLabel(now - 20_000, now)).toBe("just now");
    expect(agoLabel(now - 5 * 60_000, now)).toBe("5 min ago");
  });
});
