import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDefaultConfig, type RepositoryDetection } from "@llmatic/core";
import { createMarkdownTaskProvider, detectMarkdownTaskFile } from "../src/index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
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

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "llmatic-tasks-"));
  roots.push(root);

  await writeFile(
    join(root, "TASKS.md"),
    [
      "# Tasks",
      "",
      "Intro text must stay unchanged.",
      "",
      "## TASK-001 — Foundation",
      "",
      "Status: Done",
      "",
      "### Description",
      "Bootstrap the project.",
      "",
      "### Acceptance criteria",
      "- Repository exists",
      "- CI exists",
      "",
      "### DoD",
      "- Tests pass",
      "",
      "## TASK-002 — API",
      "",
      "Status: Todo",
      "",
      "### Dependencies",
      "- TASK-001",
      "",
      "### Acceptance criteria",
      "- GET endpoint exists",
      "",
      "## TASK-003 — UI",
      "",
      "Status: Todo",
      "",
      "### Dependencies",
      "- TASK-999",
      "",
    ].join("\n"),
    "utf8",
  );

  return root;
}

describe("MarkdownTaskProvider", () => {
  it("detects and parses TASKS.md into canonical tasks", async () => {
    const root = await fixture();

    expect(await detectMarkdownTaskFile(root)).toBe(join(root, "TASKS.md"));

    const provider = await createMarkdownTaskProvider(root, config(root));
    const tasks = await provider.listTasks();

    expect(tasks).toHaveLength(3);
    expect(tasks[0]).toMatchObject({
      key: "TASK-001",
      summary: "Foundation",
      status: { lifecycle: "done" },
      acceptanceCriteria: ["Repository exists", "CI exists"],
      definitionOfDone: ["Tests pass"],
    });
  });

  it("selects the first unblocked todo task", async () => {
    const root = await fixture();
    const provider = await createMarkdownTaskProvider(root, config(root));

    expect((await provider.getNextTask())?.key).toBe("TASK-002");
  });

  it("updates only task-local status and notes while preserving unrelated markdown", async () => {
    const root = await fixture();
    const runtime = config(root);
    runtime.permissions.taskWrite = "auto";
    const provider = await createMarkdownTaskProvider(root, runtime);

    await provider.transitionTask("TASK-002", "start");
    await provider.addComment("TASK-002", "PR #42");

    const raw = await readFile(join(root, "TASKS.md"), "utf8");
    expect(raw).toContain("Intro text must stay unchanged.");
    expect(raw).toContain("Status: In Progress");
    expect(raw).toContain("### Notes\n- PR #42");
    expect(raw).toContain("TASK-003 — UI");
  });

  it("respects taskWrite ask permission", async () => {
    const root = await fixture();
    const provider = await createMarkdownTaskProvider(root, config(root));

    await expect(provider.transitionTask("TASK-002", "start")).rejects.toThrow("requires approval");
  });

  it("treats explicit no-dependency markers as empty dependencies", async () => {
    const root = await fixtureRepository();
    await writeFile(
      join(root, "TASKS.md"),
      [
        "# Tasks",
        "",
        "## PLAN-001 — Foundation",
        "",
        "Status: Todo",
        "",
        "### Dependencies",
        "",
        "- None",
        "",
        "## PLAN-002 — CI",
        "",
        "Status: Todo",
        "",
        "### Dependencies",
        "",
        "- PLAN-001",
        "",
      ].join("\n"),
      "utf8",
    );

    const detection = await detectRepository(root);
    const config = createDefaultConfig(detection);
    const provider = await createMarkdownTaskProvider(root, config);

    const first = await provider.getTask("PLAN-001");
    expect(first.dependencies).toEqual([]);
    expect((await provider.getNextTask())?.key).toBe("PLAN-001");
  });
});
