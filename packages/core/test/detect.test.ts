import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectRepository } from "../src/detect.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("detectRepository", () => {
  it("detects a pnpm TypeScript repository and standard capabilities", async () => {
    const root = await mkdtemp(join(tmpdir(), "llmatic-detect-"));
    temporaryDirectories.push(root);

    await mkdir(join(root, ".git"));
    await writeFile(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        packageManager: "pnpm@10.0.0",
        scripts: {
          lint: "eslint .",
          typecheck: "tsc --noEmit",
          test: "vitest run",
          build: "vite build",
        },
        devDependencies: {
          typescript: "^5.0.0",
          vite: "^6.0.0",
          vitest: "^2.0.0",
        },
      }),
    );

    const detection = await detectRepository(root);

    expect(detection.git).toBe(true);
    expect(detection.packageManager).toBe("pnpm");
    expect(detection.technologies).toEqual(
      expect.arrayContaining(["TypeScript", "Vite", "Vitest"]),
    );
    expect(
      detection.capabilities
        .filter((capability) => capability.available)
        .map((capability) => capability.name),
    ).toEqual(expect.arrayContaining(["lint", "typecheck", "test", "build"]));
  });
});
