#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { analyzeArchitectureImpact } from "../packages/architecture-impact/dist/index.js";
import {
  createDefaultConfig,
  detectRepository,
} from "../packages/core/dist/index.js";
import {
  answerDiscoveryQuestion,
  createDiscoverySession,
} from "../packages/discovery-engine/dist/index.js";
import { createMarkdownTaskProvider } from "../packages/markdown-task-source/dist/index.js";
import { generateProjectPlan } from "../packages/planning-engine/dist/index.js";
import {
  approveCurrentProjectPlan,
  initializeApprovedProject,
  planApprovalStatus,
} from "../packages/project-initializer/dist/index.js";
import { listChangedFiles } from "../packages/review-engine/dist/index.js";

function fail(message) {
  throw new Error("Product acceptance failed: " + message);
}

function run(root, command, args, label) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: process.env,
    encoding: "utf8",
    shell: process.platform === "win32",
  });

  if (result.error) {
    fail(label + " could not start: " + result.error.message);
  }

  if (result.status !== 0) {
    fail(
      label +
        " exited with " +
        String(result.status) +
        ": " +
        String(result.stderr || result.stdout).trim(),
    );
  }

  return String(result.stdout || "").trim();
}

async function answerAllDiscovery(root, workspace) {
  let session = await createDiscoverySession(
    root,
    workspace,
    "Build a B2B property analysis SaaS",
  );

  const answers = [
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
    session = await answerDiscoveryQuestion(
      workspace,
      session,
      questionId,
      {
        mode: "option",
        value,
      },
    );
  }

  if (session.status !== "ready_for_planning") {
    fail("discovery did not reach ready_for_planning.");
  }

  return session;
}

async function main() {
  const root = await mkdtemp(join(tmpdir(), "llmatic-product-acceptance-root-"));
  const workspace = await mkdtemp(
    join(tmpdir(), "llmatic-product-acceptance-workspace-"),
  );

  try {
    run(root, "git", ["init"], "git init");
    run(root, "git", ["config", "user.email", "acceptance@llmatic.test"], "git config email");
    run(root, "git", ["config", "user.name", "LLMatic Acceptance"], "git config name");

    await writeFile(
      resolve(root, "README.md"),
      "# Product acceptance fixture\n",
      "utf8",
    );

    const session = await answerAllDiscovery(root, workspace);
    const generated = await generateProjectPlan(workspace, session);

    if (generated.manifest.status !== "draft_ready") {
      fail("plan did not reach draft_ready.");
    }

    const approval = await approveCurrentProjectPlan(workspace);
    const approvalStatus = await planApprovalStatus(workspace);

    if (
      !approvalStatus.verified ||
      approvalStatus.currentPlanId !== approval.planId
    ) {
      fail("exact plan approval was not verified.");
    }

    const detection = await detectRepository(root);
    const config = createDefaultConfig(detection);
    config.runtime.stateDirectory = resolve(workspace, "state");
    config.runtime.cacheDirectory = resolve(workspace, "cache");

    const initialized = await initializeApprovedProject(
      root,
      workspace,
      config,
    );

    if (initialized.lifecycle.state !== "READY_FOR_IMPLEMENTATION") {
      fail("initialization did not reach READY_FOR_IMPLEMENTATION.");
    }

    if (
      initialized.nextTaskKey !== "PLAN-001" ||
      initialized.workflow.taskRef !== "PLAN-001" ||
      initialized.workflow.state !== "TASK_SELECTED"
    ) {
      fail("first dependency-unblocked task was not selected.");
    }

    const approvedPlan = await readFile(
      resolve(root, "docs", "planning", "APPROVED_PLAN.md"),
      "utf8",
    );
    if (!approvedPlan.includes(approval.planDigest)) {
      fail("materialized approved-plan evidence does not contain the approved digest.");
    }

    run(root, "git", ["add", "."], "baseline stage");
    run(root, "git", ["commit", "-m", "accepted initialized baseline"], "baseline commit");

    await mkdir(resolve(root, "apps", "api", "src", "routes"), {
      recursive: true,
    });
    await writeFile(
      resolve(root, "apps", "api", "src", "routes", "parcels.ts"),
      "export const route = '/api/parcels';\n",
      "utf8",
    );

    const driftFiles = listChangedFiles(root);
    const drift = await analyzeArchitectureImpact(root, driftFiles);

    if (
      !drift.unresolvedAreas.includes("api_contract") ||
      !drift.unresolvedAreas.includes("testing")
    ) {
      fail(
        "living-architecture gate did not block API drift with missing contract/test evidence.",
      );
    }

    await writeFile(
      resolve(root, "packages", "contracts", "src", "parcels.ts"),
      "export interface ParcelContract { id: string }\n",
      "utf8",
    );
    await mkdir(resolve(root, "apps", "api", "test"), {
      recursive: true,
    });
    await writeFile(
      resolve(root, "apps", "api", "test", "parcels.test.ts"),
      "export const apiContractCovered = true;\n",
      "utf8",
    );

    const synchronizedFiles = listChangedFiles(root);
    const synchronized = await analyzeArchitectureImpact(
      root,
      synchronizedFiles,
    );

    if (synchronized.unresolvedCount !== 0) {
      fail(
        "living-architecture gate remained blocked after synchronized API contract/test evidence: " +
          synchronized.unresolvedAreas.join(", "),
      );
    }

    const taskProvider = await createMarkdownTaskProvider(
      root,
      config,
      "TASKS.md",
    );
    await taskProvider.transitionTask("PLAN-001", "complete", {
      approved: true,
    });
    const next = await taskProvider.getNextTask();

    if (!next || next.key !== "PLAN-002") {
      fail(
        "dependency-aware task queue did not advance from PLAN-001 to PLAN-002.",
      );
    }

    console.log("");
    console.log("========================================");
    console.log("PRODUCT LIFECYCLE ACCEPTANCE PASSED");
    console.log("Discovery: ready_for_planning");
    console.log("Planning: draft_ready");
    console.log("Approval: exact plan + discovery digest verified");
    console.log("Initialization: READY_FOR_IMPLEMENTATION");
    console.log("First task: PLAN-001 selected");
    console.log("Living architecture: drift blocked, synchronized change accepted");
    console.log("Task queue: PLAN-001 -> PLAN-002");
    console.log("Repository footprint: approved plan materialized only after approval");
    console.log("========================================");
  } finally {
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(workspace, { recursive: true, force: true }),
    ]);
  }
}

await main();
