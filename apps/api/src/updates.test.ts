import { describe, expect, test } from "bun:test";
import { compareVersions, updateSourceFromEnv } from "./updates";

const sign = (n: number) => Math.sign(n);

describe("compareVersions", () => {
  test("orders by major, minor and patch", () => {
    expect(sign(compareVersions("0.2.0", "0.1.9"))).toBe(1);
    expect(sign(compareVersions("1.10.0", "1.9.3"))).toBe(1);
    expect(sign(compareVersions("1.0.0", "1.0.1"))).toBe(-1);
    expect(compareVersions("v1.2.3", "1.2.3")).toBe(0);
  });

  test("follows SemVer pre-release precedence", () => {
    const ordered = ["1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta", "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0"];
    for (let i = 1; i < ordered.length; i++) {
      expect(sign(compareVersions(ordered[i]!, ordered[i - 1]!))).toBe(1);
      expect(sign(compareVersions(ordered[i - 1]!, ordered[i]!))).toBe(-1);
    }
  });

  test("ignores build metadata", () => {
    expect(compareVersions("0.1.0+202611162215", "0.1.0")).toBe(0);
    expect(sign(compareVersions("0.1.1", "0.1.0+202611162215"))).toBe(1);
  });
});

describe("updateSourceFromEnv", () => {
  test("uses the project repository by default", () => {
    expect(updateSourceFromEnv({})).toEqual({ kind: "github", repo: "agustinglez/eaglepanel" });
  });

  test("a server can point to another repository or a manifest", () => {
    expect(updateSourceFromEnv({ EAGLEPANEL_UPDATE_REPO: "me/fork" })).toEqual({ kind: "github", repo: "me/fork" });
    expect(updateSourceFromEnv({ EAGLEPANEL_UPDATE_URL: "https://example.com/latest.json" })).toEqual({ kind: "manifest", url: "https://example.com/latest.json" });
    expect(updateSourceFromEnv({ EAGLEPANEL_UPDATE_URL: "http://example.com/latest.json" })).toBeNull();
  });
});
