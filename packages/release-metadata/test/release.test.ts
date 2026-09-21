import { describe, expect, it } from "vitest";
import {
  assertReleaseVersion,
  compareSemver,
  parseReleaseManifest,
} from "../src/release.js";

describe("release metadata", () => {
  it("orders semantic versions for update checks", () => {
    expect(compareSemver("0.2.0", "0.1.9")).toBe(1);
    expect(compareSemver("1.0.0", "1.0.0")).toBe(0);
    expect(compareSemver("1.0.0-beta.1", "1.0.0")).toBe(-1);
  });

  it("requires tag, root package, and extension package versions to match", () => {
    expect(assertReleaseVersion("v0.1.0", "0.1.0", "0.1.0")).toBe("0.1.0");
    expect(() => assertReleaseVersion("v0.2.0", "0.1.0", "0.2.0")).toThrow(
      "does not match",
    );
  });

  it("validates a release manifest before the extension trusts it", () => {
    const manifest = parseReleaseManifest({
      schemaVersion: 1,
      version: "0.1.0",
      tag: "v0.1.0",
      commit: "a".repeat(40),
      repository: "pikkst/llmatic-agent-runtime",
      vsix: {
        file: "llmatic-agent-runtime-0.1.0.vsix",
        sha256: "b".repeat(64),
        size: 123,
      },
      runtime: {
        version: "0.1.0",
        sha256: "c".repeat(64),
        size: 456,
      },
    });

    expect(manifest.version).toBe("0.1.0");
  });
});
