import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DiscoverySession } from "@llmatic/discovery-engine";
import {
  currentPlanPath,
  generateProjectPlan,
  loadCurrentProjectPlan,
  loadProjectPlanManifest,
  planDirectory,
} from "../src/index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function discovery(projectRoot: string): DiscoverySession {
  const now = "2026-09-21T00:00:00.000Z";
  const answer = (questionId: string, value: string, label: string) => ({
    questionId,
    value,
    label,
    source: "user_option" as const,
    answeredAt: now,
  });

  return {
    version: 1,
    sessionId: "11111111-1111-4111-8111-111111111111",
    projectRoot,
    idea: "Build a B2B property analysis SaaS",
    status: "ready_for_planning",
    policyPackVersion: 1,
    createdAt: now,
    updatedAt: now,
    answers: {
      product_type: answer("product_type", "saas_web", "SaaS web application"),
      maturity: answer("maturity", "mvp", "MVP"),
      primary_users: answer("primary_users", "business", "Business customers"),
      application_shape: answer("application_shape", "fullstack_web", "Full-stack web"),
      authentication: answer("authentication", "email_oauth", "Email + OAuth"),
      tenancy: answer("tenancy", "organizations", "Organizations / workspaces"),
      data_store: answer("data_store", "managed_postgres", "Managed PostgreSQL"),
      deployment: answer("deployment", "managed_cloud", "Managed cloud"),
      testing: answer("testing", "balanced", "Balanced"),
      security: answer("security", "standard", "Standard application security"),
    },
  };
}

describe("project planning engine", () => {
  it("generates a complete versioned private plan bundle", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "llmatic-plan-"));
    roots.push(workspace);

    const result = await generateProjectPlan(workspace, discovery("/repo"));

    expect(result.manifest.status).toBe("draft_ready");
    expect(result.manifest.artifactCount).toBeGreaterThanOrEqual(15);
    expect(result.manifest.taskCount).toBeGreaterThanOrEqual(10);
    expect(result.current.planDirectory).toBe(planDirectory(workspace, result.manifest.planId));

    const tasks = await readFile(resolve(result.current.planDirectory, "TASKS.md"), "utf8");
    expect(tasks).toContain("PLAN-001");
    expect(tasks).toContain("PLAN-013");
    expect(tasks).toContain("PLAN-031");
    expect(tasks).toContain("### Dependencies");

    const graph = JSON.parse(
      await readFile(resolve(result.current.planDirectory, "dependency-graph.json"), "utf8"),
    ) as {
      edges: Array<{ from: string; to: string; type: string }>;
    };

    expect(graph.edges).toContainEqual({
      from: "PLAN-001",
      to: "PLAN-002",
      type: "blocks",
    });
  });

  it("applies requested changes to a product-specific regenerated plan", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "llmatic-plan-"));
    roots.push(workspace);

    const session = discovery("/repo");
    session.idea =
      "Build a small personal task management web application where users can create, edit, complete and delete tasks.";
    session.answers.primary_users = {
      ...session.answers.primary_users,
      value: "consumer",
      label: "Consumers",
    };
    session.answers.tenancy = {
      ...session.answers.tenancy,
      value: "single_user",
      label: "Individual accounts",
    };

    const changeRequest = [
      "Make the plan concrete for a personal task manager.",
      "Users must create, view, edit, complete/uncomplete and delete only their own tasks.",
      "Task fields include title, optional description, completion state and created/updated timestamps.",
    ].join(" ");

    const result = await generateProjectPlan(workspace, session, { changeRequest });
    const read = (name: string) => readFile(resolve(result.current.planDirectory, name), "utf8");

    const [brief, requirements, dataModel, api, tasks, graphRaw] = await Promise.all([
      read("PRODUCT_BRIEF.md"),
      read("REQUIREMENTS.md"),
      read("DATA_MODEL.md"),
      read("API_CONTRACTS.md"),
      read("TASKS.md"),
      read("dependency-graph.json"),
    ]);

    expect(brief).toContain("Requested plan refinements");
    expect(brief).toContain("personal task manager");
    expect(requirements).toContain("Task lifecycle");
    expect(requirements).toContain("owned by that user");
    expect(dataModel).toContain("## Task fields");
    expect(dataModel).toContain("ownerUserId");
    expect(dataModel).toContain("title");
    expect(dataModel).toContain("description");
    expect(dataModel).toContain("completed");
    expect(dataModel).toContain("createdAt");
    expect(dataModel).toContain("updatedAt");
    expect(api).toContain("GET    /api/tasks");
    expect(api).toContain("DELETE /api/tasks/:id");
    expect(tasks).toContain("Define Task domain model and lifecycle use-cases");
    expect(tasks).toContain("Implement Task lifecycle end to end");

    const graph = JSON.parse(graphRaw) as {
      edges: Array<{ from: string; to: string; type: string }>;
    };
    expect(graph.edges).toContainEqual({
      from: "PLAN-031",
      to: "PLAN-040",
      type: "blocks",
    });
  });

  it("does not generate a plan before discovery is ready", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "llmatic-plan-"));
    roots.push(workspace);

    const session = discovery("/repo");
    session.status = "in_progress";

    await expect(generateProjectPlan(workspace, session)).rejects.toThrow("Finish discovery");
  });

  it("regeneration creates a new plan while preserving the previous draft", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "llmatic-plan-"));
    roots.push(workspace);

    const session = discovery("/repo");
    const first = await generateProjectPlan(workspace, session);
    const second = await generateProjectPlan(workspace, session);

    expect(second.manifest.planId).not.toBe(first.manifest.planId);
    expect((await loadCurrentProjectPlan(workspace))?.planId).toBe(second.manifest.planId);
    expect((await loadProjectPlanManifest(workspace, first.manifest.planId))?.planId).toBe(
      first.manifest.planId,
    );
    expect(currentPlanPath(workspace).startsWith(workspace)).toBe(true);
  });
});
