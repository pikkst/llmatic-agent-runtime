import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDefaultConfig } from "../src/config.js";
import { detectRepository } from "../src/detect.js";
import { executeCapability } from "../src/executor.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

async function createRepository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "llmatic-executor-"));
  temporaryDirectories.push(root);

  await mkdir(join(root, ".git"));
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      packageManager: "pnpm@10.17.1",
      scripts: {
        test: "vitest run",
      },
    }),
  );

  return root;
}

describe("executeCapability", () => {
  it("runs a detected capability using structured executable arguments", async () => {
    const root = await createRepository();
    const detection = await detectRepository(root);
    const config = createDefaultConfig(detection);
    const runner = vi.fn(() => ({ exitCode: 0 }));

    const result = await executeCapability(root, config, "test", { runner });

    expect(runner).toHaveBeenCalledWith("pnpm", ["run", "test"], root);
    expect(result.success).toBe(true);
    expect(result.command).toBe("pnpm run test");
  });

  it("enforces ask permissions unless explicitly approved", async () => {
    const root = await createRepository();
    const detection = await detectRepository(root);
    const config = createDefaultConfig(detection);
    config.permissions.runTests = "ask";

    await expect(executeCapability(root, config, "test")).rejects.toThrow("requires approval");
  });
});
