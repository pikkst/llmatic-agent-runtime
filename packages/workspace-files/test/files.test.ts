import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDefaultConfig, type RepositoryDetection } from "@llmatic/core";
import {
  createWorkspaceFile,
  readWorkspaceFile,
  replaceWorkspaceText,
} from "../src/files.js";

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

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "llmatic-files-"));
  temporaryDirectories.push(root);
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src", "value.ts"), "export const value = 1;\n");
  await writeFile(join(root, ".env"), "SECRET=yes\n");
  return root;
}

describe("workspace file tools", () => {
  it("reads bounded text files and applies an exact single replacement", async () => {
    const root = await fixture();
    const config = configFor(root);

    const before = await readWorkspaceFile(root, config, "src/value.ts");
    expect(before.content).toContain("value = 1");

    await replaceWorkspaceText(root, config, "src/value.ts", "value = 1", "value = 2");

    expect(await readFile(join(root, "src", "value.ts"), "utf8")).toContain("value = 2");
  });

  it("creates nested new files while refusing to overwrite existing files", async () => {
    const root = await fixture();
    const config = configFor(root);

    const result = await createWorkspaceFile(
      root,
      config,
      "src/generated/new.ts",
      "export const created = true;\n",
    );

    expect(result.changed).toBe(true);
    await expect(
      createWorkspaceFile(root, config, "src/generated/new.ts", "overwrite"),
    ).rejects.toThrow("refuses to overwrite");
  });

  it("blocks repository escape and sensitive files", async () => {
    const root = await fixture();
    const config = configFor(root);

    await expect(readWorkspaceFile(root, config, ".env")).rejects.toThrow(
      "secret/path policy",
    );
    await expect(readWorkspaceFile(root, config, "../outside.txt")).rejects.toThrow();
  });

  it("does not let the direct agent satisfy ask-gated repository writes", async () => {
    const root = await fixture();
    const config = configFor(root);
    config.permissions.repositoryWrite = "ask";

    await expect(
      replaceWorkspaceText(root, config, "src/value.ts", "1", "2"),
    ).rejects.toThrow("explicit human approval");
  });
});
