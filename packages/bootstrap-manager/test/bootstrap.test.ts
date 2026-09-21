import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDefaultConfig, type RepositoryDetection } from "@llmatic/core";
import { inspectBootstrap } from "../src/bootstrap.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

function configFor(root: string) {
  const detection: RepositoryDetection = {
    root,
    git: true,
    packageJson: true,
    packageManager: "pnpm",
    technologies: [],
    capabilities: [],
  };
  return createDefaultConfig(detection);
}

describe("bootstrap manager", () => {
  it("derives repository-specific tool requirements from project signals", async () => {
    const root = await mkdtemp(join(tmpdir(), "llmatic-bootstrap-"));
    temporaryDirectories.push(root);

    await mkdir(join(root, ".git"));
    await mkdir(join(root, "supabase"), { recursive: true });
    await mkdir(join(root, "scripts"), { recursive: true });
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        packageManager: "pnpm@10.17.1",
        scripts: { test: "vitest run" },
      }),
    );
    await writeFile(join(root, "supabase", "config.toml"), 'project_id = "demo"\n');
    await writeFile(join(root, "scripts", "check.py"), "print('ok')\n");

    const report = await inspectBootstrap(root, configFor(root));

    expect(report.requirements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "node", level: "required" }),
        expect.objectContaining({ id: "git", level: "required" }),
        expect.objectContaining({ id: "pnpm", level: "required" }),
        expect.objectContaining({ id: "github-cli", level: "recommended" }),
        expect.objectContaining({ id: "supabase", level: "recommended" }),
        expect.objectContaining({ id: "docker", level: "recommended" }),
        expect.objectContaining({ id: "python", level: "recommended" }),
        expect.objectContaining({ id: "uv", level: "optional" }),
        expect.objectContaining({ id: "ollama", level: "optional" }),
      ]),
    );
  });
});
