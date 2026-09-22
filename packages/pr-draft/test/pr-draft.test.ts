import { describe, expect, it } from "vitest";
import type { WorkflowRun } from "@llmatic/core";
import type { CodeReviewReport } from "@llmatic/review-engine";
import type { TaskRecord } from "@llmatic/task-provider";
import { buildPullRequestDraft } from "../src/index.js";

const task: TaskRecord = {
  provider: "markdown",
  id: "TASK-1",
  key: "TASK-1",
  summary: "Add secure task endpoint",
  description: "Implement one authenticated endpoint.",
  status: {
    id: "in_progress",
    name: "In Progress",
    lifecycle: "in_progress",
  },
  labels: [],
  acceptanceCriteria: ["Authorized users can create a task."],
  definitionOfDone: ["Tests pass."],
  dependencies: [],
  source: { type: "markdown" },
};

const workflow: WorkflowRun = {
  version: 1,
  runId: "00000000-0000-4000-8000-000000000001",
  taskRef: "TASK-1",
  state: "CODE_REVIEW",
  createdAt: "2026-09-22T00:00:00.000Z",
  updatedAt: "2026-09-22T00:00:00.000Z",
  checkpoints: [
    {
      id: "00000000-0000-4000-8000-000000000002",
      kind: "CAPABILITY_RUN",
      timestamp: "2026-09-22T00:01:00.000Z",
      capability: "test",
      command: "pnpm test",
      exitCode: 0,
      success: true,
      durationMs: 1200,
    },
  ],
};

const review: CodeReviewReport = {
  summary: "general: clean security: clean",
  findings: [],
  codeBlockingCount: 0,
  blockingCount: 0,
  nonBlockingCount: 0,
  architectureImpact: {
    baselineDetected: true,
    changedFiles: ["src/tasks.ts"],
    impacts: [],
    requiredCount: 0,
    unresolvedCount: 0,
    unresolvedAreas: [],
  },
  constitution: {
    sourceCount: 2,
    activeRuleCount: 5,
    blockingRuleCount: 2,
    inferredConventionCount: 1,
    proposedRuleCount: 0,
  },
  lenses: ["general", "security"],
  model: "kilo-auto/free",
  changedFiles: ["src/tasks.ts"],
};

describe("PR draft", () => {
  it("builds an evidence-backed draft from task, workflow and review data", () => {
    const draft = buildPullRequestDraft({
      branch: "feature/TASK-1",
      base: "main",
      task,
      workflow,
      review,
    });

    expect(draft.title).toBe("TASK-1: Add secure task endpoint");
    expect(draft.body).toContain("src/tasks.ts");
    expect(draft.body).toContain("PASS test — pnpm test");
    expect(draft.body).toContain("Lenses: general, security");
    expect(draft.body).toContain("Security lens ran with no supported findings.");
    expect(draft.body).toContain("Active rules considered: 5");
    expect(draft.body).toContain("Authorized users can create a task.");
  });

  it("marks missing evidence instead of inventing claims", () => {
    const draft = buildPullRequestDraft({
      branch: "feature/unknown",
      base: "main",
    });

    expect(draft.body).toContain("Task/problem context has not been captured yet.");
    expect(draft.body).toContain("Validation evidence not captured yet.");
    expect(draft.body).toContain("Security review evidence not captured yet.");
    expect(draft.body).toContain("No unsupported rollback claim is generated automatically.");
  });
});
