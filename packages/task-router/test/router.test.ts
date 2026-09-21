import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDefaultConfig, type RepositoryDetection } from "@llmatic/core";
import { detectTaskSources, resolveTaskProvider } from "../src/index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function config(root: string) {
  const detection: RepositoryDetection = {
    root,
    git: true,
    packageJson: false,
    packageManager: "unknown",
    technologies: [],
    capabilities: [],
  };

  return createDefaultConfig(detection);
}

describe("task router", () => {
  it("prefers local Markdown tasks over configured Jira", async () => {
    const root = await mkdtemp(join(tmpdir(), "llmatic-router-"));
    roots.push(root);
    await writeFile(
      join(root, "TASKS.md"),
      "## TASK-001 — Local\n\nStatus: Todo\n",
      "utf8",
    );

    const detection = await detectTaskSources(root, {
      LLMATIC_JIRA_BASE_URL: "https://example.atlassian.net",
      LLMATIC_JIRA_EMAIL: "dev@example.test",
      LLMATIC_JIRA_API_TOKEN: "token",
    });

    expect(detection.selected).toBe("markdown");
  });

  it("uses Jira when no Markdown source exists and Jira is configured", async () => {
    const root = await mkdtemp(join(tmpdir(), "llmatic-router-"));
    roots.push(root);

    const detection = await detectTaskSources(root, {
      LLMATIC_JIRA_BASE_URL: "https://example.atlassian.net",
      LLMATIC_JIRA_BEARER_TOKEN: "token",
    });

    expect(detection.selected).toBe("jira");
  });

  it("falls back to manual when no source is configured", async () => {
    const root = await mkdtemp(join(tmpdir(), "llmatic-router-"));
    roots.push(root);

    const detection = await detectTaskSources(root, {});
    expect(detection.selected).toBe("manual");

    const provider = await resolveTaskProvider(root, config(root), "auto", {});
    expect(provider.id).toBe("manual");
    expect((await provider.getTask("LOCAL-1")).key).toBe("LOCAL-1");
  });
});
