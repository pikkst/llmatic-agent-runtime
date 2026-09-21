import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDefaultConfig, detectRepository } from "@llmatic/core";
import {
  answerDiscoveryQuestion,
  createDiscoverySession,
  type DiscoverySession,
} from "@llmatic/discovery-engine";
import { generateProjectPlan } from "@llmatic/planning-engine";
import {
  approveCurrentProjectPlan,
  calculateProjectPlanDigest,
  initializeApprovedProject,
  loadProjectChangeRequest,
  loadProjectLifecycle,
  planApprovalStatus,
  requestProjectPlanChanges,
} from "../src/index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function readyDiscovery(root: string, workspace: string): Promise<DiscoverySession> {
  let session = await createDiscoverySession(root, workspace, "Build a B2B property analysis SaaS");

  const answers: Array<[string, string]> = [
    ["product_type", "saas_web"],
    ["maturity", "mvp"],
    ["primary_users", "business"],
    ["application_shape", "fullstack_web"],
    ["authentication", "email_oauth"],
    ["tenancy", "organizations"],
    ["data_store", "managed_postgres"],
    ["deployment", "managed_cloud"],
    ["testing", "balanced"],
    ["security", "standard"],
  ];

  for (const [questionId, value] of answers) {
    session = await answerDiscoveryQuestion(workspace, session, questionId, {
      mode: "option",
      value,
    });
  }

  return session;
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "llmatic-init-root-"));
  const workspace = await mkdtemp(join(tmpdir(), "llmatic-init-workspace-"));
  roots.push(root, workspace);

  await mkdir(resolve(root, ".git"));
  await writeFile(resolve(root, "README.md"), "# Existing greenfield README\n", "utf8");

  const session = await readyDiscovery(root, workspace);
  await generateProjectPlan(workspace, session);

  const detection = await detectRepository(root);
  const config = createDefaultConfig(detection);
  config.runtime.stateDirectory = resolve(workspace, "state");
  config.runtime.cacheDirectory = resolve(workspace, "cache");

  return {
    root,
    workspace,
    config,
  };
}

describe("project approval and initialization", () => {
  it("binds approval to the exact current plan digest", async () => {
    const { workspace } = await fixture();

    const approval = await approveCurrentProjectPlan(workspace);
    const status = await planApprovalStatus(workspace);

    expect(status.verified).toBe(true);
    expect(status.currentDigest).toBe(approval.planDigest);
    expect(approval.planDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("invalidates approval when a new plan becomes current", async () => {
    const { root, workspace } = await fixture();

    await approveCurrentProjectPlan(workspace);
    const session = await readyDiscovery(root, workspace);
    await generateProjectPlan(workspace, session);

    const status = await planApprovalStatus(workspace);
    expect(status.verified).toBe(false);
    expect(status.reason).toContain("approval belongs to plan");
  });

  it("persists requested plan changes and invalidates prior approval", async () => {
    const { workspace } = await fixture();

    await approveCurrentProjectPlan(workspace);
    await requestProjectPlanChanges(
      workspace,
      "Make the plan product-specific and replace generic resource placeholders.",
    );

    const request = await loadProjectChangeRequest(workspace);
    const status = await planApprovalStatus(workspace);

    expect(request?.text).toContain("product-specific");
    expect(request?.requestedBy).toBe("user");
    expect(status.verified).toBe(false);
    expect(status.reason).toContain("has not been approved");
  });

  it("refuses initialization before human approval", async () => {
    const { root, workspace, config } = await fixture();

    await expect(initializeApprovedProject(root, workspace, config)).rejects.toThrow(
      "verified human approval",
    );

    expect(await readFile(resolve(root, "README.md"), "utf8")).toContain(
      "Existing greenfield README",
    );
  });

  it("materializes the approved plan and selects the first unblocked task", async () => {
    const { root, workspace, config } = await fixture();

    await approveCurrentProjectPlan(workspace);
    const result = await initializeApprovedProject(root, workspace, config);

    expect(result.lifecycle.state).toBe("READY_FOR_IMPLEMENTATION");
    expect(result.nextTaskKey).toBe("PLAN-001");
    expect(result.workflow).toMatchObject({
      taskRef: "PLAN-001",
      state: "TASK_SELECTED",
    });

    expect(await readFile(resolve(root, "TASKS.md"), "utf8")).toContain("PLAN-001");
    expect(await readFile(resolve(root, "docs", "planning", "ARCHITECTURE.md"), "utf8")).toContain(
      "# Architecture",
    );

    expect(await readFile(resolve(root, "README.md"), "utf8")).toContain(
      "Existing greenfield README",
    );

    expect((await loadProjectLifecycle(workspace))?.state).toBe("READY_FOR_IMPLEMENTATION");
  });

  it("detects tampering after approval before repository mutation", async () => {
    const { root, workspace, config } = await fixture();

    const approval = await approveCurrentProjectPlan(workspace);
    const currentDigest = await calculateProjectPlanDigest(workspace, approval.planId);
    expect(currentDigest).toBe(approval.planDigest);

    const current = JSON.parse(
      await readFile(resolve(workspace, "planning", "current-plan.json"), "utf8"),
    ) as { planDirectory: string };

    await writeFile(resolve(current.planDirectory, "ARCHITECTURE.md"), "# Tampered\n", "utf8");

    await expect(initializeApprovedProject(root, workspace, config)).rejects.toThrow(
      "verified human approval",
    );

    expect(await readFile(resolve(root, "README.md"), "utf8")).toContain(
      "Existing greenfield README",
    );
  });
});
