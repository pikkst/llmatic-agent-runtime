import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureManagedWorkspace } from "../src/workspace.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("managed workspace", () => {
  it("keeps config/state/cache outside the repository and uses local git excludes", async () => {
    const root = await mkdtemp(join(tmpdir(), "llmatic-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "llmatic-home-"));
    temporaryDirectories.push(root, home);

    await mkdir(join(root, ".git", "info"), { recursive: true });

    const workspace = await ensureManagedWorkspace(root, home);

    expect(workspace.directory.startsWith(home)).toBe(true);
    expect(workspace.configPath.startsWith(home)).toBe(true);
    expect(workspace.stateDirectory.startsWith(home)).toBe(true);
    expect(workspace.cacheDirectory.startsWith(home)).toBe(true);
    expect(workspace.created).toBe(true);

    await expect(readFile(join(root, "llmatic.agent.yaml"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readFile(join(root, ".llmatic", "state"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });

    const excludes = await readFile(join(root, ".git", "info", "exclude"), "utf8");
    expect(excludes).toContain(".llmatic/");
    expect(excludes).toContain("llmatic.agent.local.yaml");

    const loadedAgain = await ensureManagedWorkspace(root, home);
    expect(loadedAgain.created).toBe(false);
    expect(loadedAgain.gitExcludeUpdated).toBe(false);
  });
});
