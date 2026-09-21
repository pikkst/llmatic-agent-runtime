import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stageVerifiedVsix, verifyVsixBytes } from "../src/update.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

function fixtureBytes(): Uint8Array {
  return new TextEncoder().encode("verified-vsix-bytes");
}

describe("verified VSIX updater", () => {
  it("rejects size or SHA-256 mismatches before staging", () => {
    const bytes = fixtureBytes();
    const sha256 = createHash("sha256").update(bytes).digest("hex");

    expect(() =>
      verifyVsixBytes(bytes, {
        file: "llmatic-agent-runtime-0.2.0.vsix",
        sha256,
        size: bytes.byteLength + 1,
      }),
    ).toThrow("size");

    expect(() =>
      verifyVsixBytes(bytes, {
        file: "llmatic-agent-runtime-0.2.0.vsix",
        sha256: "0".repeat(64),
        size: bytes.byteLength,
      }),
    ).toThrow("SHA-256");
  });

  it("stages only verified bytes in versioned external update storage", async () => {
    const home = await mkdtemp(join(tmpdir(), "llmatic-update-"));
    temporaryDirectories.push(home);
    const bytes = fixtureBytes();
    const sha256 = createHash("sha256").update(bytes).digest("hex");

    const staged = await stageVerifiedVsix({
      bytes,
      expected: {
        file: "llmatic-agent-runtime-0.2.0.vsix",
        sha256,
        size: bytes.byteLength,
      },
      updateHome: home,
      version: "0.2.0",
    });

    expect(staged.path).toContain(join("updates", "0.2.0", sha256.slice(0, 16)));
    expect(new Uint8Array(await readFile(staged.path))).toEqual(bytes);
  });

  it("rejects traversal-style VSIX names", () => {
    const bytes = fixtureBytes();
    const sha256 = createHash("sha256").update(bytes).digest("hex");

    expect(() =>
      verifyVsixBytes(bytes, {
        file: "../malicious.vsix",
        sha256,
        size: bytes.byteLength,
      }),
    ).toThrow("plain .vsix");
  });
});
