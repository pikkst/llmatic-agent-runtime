import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { analyzeArchitectureImpact, architectureImpactSummary } from "../src/index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(withBaseline = true): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "llmatic-impact-"));
  roots.push(root);

  if (withBaseline) {
    await mkdir(join(root, "docs", "planning"), {
      recursive: true,
    });
    await writeFile(join(root, "docs", "planning", "APPROVED_PLAN.md"), "# Approved\n");
    await writeFile(join(root, "TASKS.md"), "# Tasks\n");
  }

  return root;
}

describe("living architecture impact", () => {
  it("does not enforce plan synchronization without an initialized baseline", async () => {
    const root = await fixture(false);
    const report = await analyzeArchitectureImpact(root, ["apps/api/src/routes/users.ts"]);

    expect(report.baselineDetected).toBe(false);
    expect(report.unresolvedCount).toBe(0);
  });

  it("requires API contract and test evidence for API implementation changes", async () => {
    const root = await fixture();
    const report = await analyzeArchitectureImpact(root, ["apps/api/src/routes/users.ts"]);

    expect(report.unresolvedAreas).toEqual(["api_contract", "testing"]);
  });

  it("accepts synchronized API contract and test changes", async () => {
    const root = await fixture();
    const report = await analyzeArchitectureImpact(root, [
      "apps/api/src/routes/users.ts",
      "packages/contracts/src/users.ts",
      "apps/api/test/users.test.ts",
    ]);

    expect(report.unresolvedCount).toBe(0);
    expect(architectureImpactSummary(report)).toContain("synchronization evidence");
  });

  it("requires schema documentation for migrations", async () => {
    const root = await fixture();
    const report = await analyzeArchitectureImpact(root, [
      "supabase/migrations/20260921_users.sql",
      "src/users.ts",
      "test/users.test.ts",
    ]);

    expect(report.unresolvedAreas).toContain("schema");

    const synchronized = await analyzeArchitectureImpact(root, [
      "supabase/migrations/20260921_users.sql",
      "docs/planning/DATA_MODEL.md",
      "src/users.ts",
      "test/users.test.ts",
    ]);

    expect(synchronized.unresolvedAreas).not.toContain("schema");
  });

  it("requires task graph synchronization when planning decisions change", async () => {
    const root = await fixture();
    const report = await analyzeArchitectureImpact(root, [
      "docs/planning/adr/ADR-004-new-boundary.md",
    ]);

    expect(report.unresolvedAreas).toContain("task_graph");

    const synchronized = await analyzeArchitectureImpact(root, [
      "docs/planning/adr/ADR-004-new-boundary.md",
      "TASKS.md",
    ]);
    expect(synchronized.unresolvedAreas).not.toContain("task_graph");
  });
});
