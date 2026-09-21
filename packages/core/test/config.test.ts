import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveAgentConfigPath } from "../src/config.js";
import { managedWorkspaceConfigPath } from "../src/workspace.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("agent config resolution", () => {
  it("prefers explicit config, then repository policy, then managed workspace config", async () => {
    const root = await mkdtemp(join(tmpdir(), "llmatic-config-"));
    const home = await mkdtemp(join(tmpdir(), "llmatic-home-"));
    temporaryDirectories.push(root, home);

    const managed = managedWorkspaceConfigPath(root, home);
    await mkdir(join(managed, ".."), { recursive: true });
    await writeFile(managed, "version: 1\n");

    expect(await resolveAgentConfigPath(root, { LLMATIC_HOME: home })).toBe(managed);

    const repositoryConfig = join(root, "llmatic.agent.yaml");
    await writeFile(repositoryConfig, "version: 1\n");
    expect(await resolveAgentConfigPath(root, { LLMATIC_HOME: home })).toBe(repositoryConfig);

    const explicit = join(home, "explicit.yaml");
    expect(
      await resolveAgentConfigPath(root, {
        LLMATIC_HOME: home,
        LLMATIC_CONFIG_PATH: explicit,
      }),
    ).toBe(explicit);
  });
});
