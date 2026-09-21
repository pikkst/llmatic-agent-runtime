import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  WorkflowStateStore,
  createDefaultConfig,
  startWorkflow,
  transitionWorkflow,
  type RepositoryDetection,
} from "@llmatic/core";
import type {
  GatewayChatClient,
  GatewayChatRequest,
  GatewayChatResponse,
} from "@llmatic/gateway-client";
import { listChangedFiles, runCodeReview } from "../src/review.js";

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

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "llmatic-review-"));
  temporaryDirectories.push(root);

  if (spawnSync("git", ["init"], { cwd: root, encoding: "utf8", shell: false }).status !== 0) {
    throw new Error("git init failed");
  }
  spawnSync("git", ["config", "user.email", "test@example.test"], { cwd: root });
  spawnSync("git", ["config", "user.name", "LLMatic Test"], { cwd: root });

  await mkdir(join(root, "src"));
  await writeFile(join(root, "src", "value.ts"), "export const value = 1;\n");
  await writeFile(join(root, ".env"), "SECRET=yes\n");
  spawnSync("git", ["add", "."], { cwd: root });
  if (spawnSync("git", ["commit", "-m", "initial"], { cwd: root }).status !== 0) {
    throw new Error("git commit failed");
  }

  await writeFile(join(root, "src", "value.ts"), "export const value = 2;\n");
  await writeFile(join(root, ".env"), "SECRET=changed\n");
  return root;
}

class ScriptedGateway implements GatewayChatClient {
  public readonly requests: GatewayChatRequest[] = [];
  public constructor(private readonly responses: GatewayChatResponse[]) {}
  public async createChatCompletion(request: GatewayChatRequest): Promise<GatewayChatResponse> {
    this.requests.push(request);
    const response = this.responses.shift();
    if (!response) throw new Error("No scripted review response remains.");
    return response;
  }
}

function response(content: string): GatewayChatResponse {
  return {
    id: "review",
    model: "kilo-auto/free",
    choices: [{ index: 0, message: { role: "assistant", content } }],
  };
}

async function moveToCodeReview(store: WorkflowStateStore): Promise<void> {
  await transitionWorkflow(store, "TASK_VALIDATED");
  await transitionWorkflow(store, "REPO_ANALYZED");
  await transitionWorkflow(store, "BRANCH_CREATED");
  await transitionWorkflow(store, "IMPLEMENTING");
  await transitionWorkflow(store, "LOCAL_VALIDATION");
  await transitionWorkflow(store, "CODE_REVIEW");
}

describe("review engine", () => {
  it("filters sensitive changed paths from review context", async () => {
    const root = await repository();
    expect(listChangedFiles(root)).toEqual(["src/value.ts"]);
  });

  it("moves CODE_REVIEW to FIXING for blocking findings", async () => {
    const root = await repository();
    const config = configFor(root);
    const store = new WorkflowStateStore(root, config);
    await startWorkflow(store, "TASK-700");
    await moveToCodeReview(store);

    const gateway = new ScriptedGateway([
      response(
        JSON.stringify({
          summary: "One blocking defect.",
          findings: [
            {
              severity: "blocking",
              category: "correctness",
              title: "Incorrect value",
              path: "src/value.ts",
              line: 1,
              evidence: "The changed constant violates the expected contract.",
              recommendation: "Restore the required value.",
            },
          ],
        }),
      ),
    ]);

    const report = await runCodeReview({ root, config, store, gateway });
    expect(report.blockingCount).toBe(1);
    expect((await store.loadCurrent())?.state).toBe("FIXING");
    expect(gateway.requests[0]?.model).toBe("kilo-auto/free");
  });

  it("moves CODE_REVIEW to READY_TO_PUSH when review is clear", async () => {
    const root = await repository();
    const config = configFor(root);
    const store = new WorkflowStateStore(root, config);
    await startWorkflow(store, "TASK-701");
    await moveToCodeReview(store);

    const gateway = new ScriptedGateway([
      response(
        JSON.stringify({
          summary: "No blocking defects found.",
          findings: [],
        }),
      ),
    ]);

    const report = await runCodeReview({ root, config, store, gateway });
    expect(report.blockingCount).toBe(0);
    expect((await store.loadCurrent())?.state).toBe("READY_TO_PUSH");
  });

  it("blocks a clear model review when living-architecture evidence is missing", async () => {
    const root = await repository();
    await mkdir(join(root, "docs", "planning"), {
      recursive: true,
    });
    await writeFile(
      join(root, "docs", "planning", "APPROVED_PLAN.md"),
      "# Approved\n",
    );
    await writeFile(join(root, "TASKS.md"), "# Tasks\n");

    const config = configFor(root);
    const store = new WorkflowStateStore(root, config);
    await startWorkflow(store, "TASK-702");
    await moveToCodeReview(store);

    const gateway = new ScriptedGateway([
      response(
        JSON.stringify({
          summary: "No code defects found.",
          findings: [],
        }),
      ),
    ]);

    const report = await runCodeReview({
      root,
      config,
      store,
      gateway,
    });

    expect(report.codeBlockingCount).toBe(0);
    expect(report.architectureImpact.unresolvedAreas).toContain(
      "testing",
    );
    expect(report.blockingCount).toBe(1);
    expect((await store.loadCurrent())?.state).toBe("FIXING");
  });

  it("allows review to advance when living-architecture evidence is synchronized", async () => {
    const root = await repository();
    await mkdir(join(root, "docs", "planning"), {
      recursive: true,
    });
    await writeFile(
      join(root, "docs", "planning", "APPROVED_PLAN.md"),
      "# Approved\n",
    );
    await writeFile(join(root, "TASKS.md"), "# Tasks\n");
    await writeFile(
      join(root, "src", "value.test.ts"),
      "export const covered = true;\n",
    );

    const config = configFor(root);
    const store = new WorkflowStateStore(root, config);
    await startWorkflow(store, "TASK-703");
    await moveToCodeReview(store);

    const gateway = new ScriptedGateway([
      response(
        JSON.stringify({
          summary: "No code defects found.",
          findings: [],
        }),
      ),
    ]);

    const report = await runCodeReview({
      root,
      config,
      store,
      gateway,
    });

    expect(report.architectureImpact.unresolvedCount).toBe(0);
    expect(report.blockingCount).toBe(0);
    expect((await store.loadCurrent())?.state).toBe(
      "READY_TO_PUSH",
    );
  });

});
