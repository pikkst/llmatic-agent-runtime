import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  installRuntimeBundle,
  inspectInstalledRuntime,
  readRuntimeManifest,
} from "../src/runtime.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "llmatic-runtime-"));
  temporaryDirectories.push(root);
  const bundlePath = join(root, "mcp-server.mjs");
  const manifestPath = join(root, "manifest.json");
  const runtimeHome = join(root, "home");
  const content = "console.log('runtime');\n";
  const sha256 = createHash("sha256").update(content).digest("hex");

  await writeFile(bundlePath, content, "utf8");
  await writeFile(
    manifestPath,
    JSON.stringify({
      schemaVersion: 1,
      runtimeVersion: "0.1.0",
      file: "mcp-server.mjs",
      sha256,
      size: Buffer.byteLength(content),
    }),
    "utf8",
  );

  return { bundlePath, manifestPath, runtimeHome, sha256 };
}

describe("runtime installer", () => {
  it("installs a verified runtime into versioned global storage", async () => {
    const item = await fixture();
    const installed = await installRuntimeBundle(item);

    expect(installed.healthy).toBe(true);
    expect(installed.changed).toBe(true);
    expect(installed.serverPath).toContain(item.sha256.slice(0, 16));
    expect(await readFile(installed.serverPath, "utf8")).toContain("runtime");

    const manifest = await readRuntimeManifest(item.manifestPath);
    const inspected = await inspectInstalledRuntime(item.runtimeHome, manifest);
    expect(inspected.healthy).toBe(true);
  });

  it("repairs a corrupted installed runtime", async () => {
    const item = await fixture();
    const installed = await installRuntimeBundle(item);
    await writeFile(installed.serverPath, "corrupt", "utf8");

    const manifest = await readRuntimeManifest(item.manifestPath);
    expect((await inspectInstalledRuntime(item.runtimeHome, manifest)).healthy).toBe(false);

    const repaired = await installRuntimeBundle({ ...item, force: true });
    expect(repaired.healthy).toBe(true);
    expect(repaired.changed).toBe(true);
  });

  it("rejects a bundled runtime whose bytes do not match the manifest", async () => {
    const item = await fixture();
    await writeFile(item.bundlePath, "tampered", "utf8");

    await expect(installRuntimeBundle(item)).rejects.toThrow(
      /does not match its manifest/,
    );
  });
});
