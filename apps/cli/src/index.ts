#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Command } from "commander";
import {
  WORKFLOW_STATES,
  WorkflowStateStore,
  createDefaultConfig,
  detectRepository,
  executeCapability,
  loadAgentConfig,
  normalizeWorkflowState,
  recordCapabilityCheckpoint,
  runDoctor,
  serializeConfig,
  startWorkflow,
  transitionWorkflow,
  type CapabilityName,
  type RepositoryDetection,
  type WorkflowRun,
} from "@llmatic/core";

const program = new Command();

function printDetection(detection: RepositoryDetection): void {
  console.log("Repository: " + detection.root);
  console.log("Git: " + (detection.git ? "yes" : "no"));
  console.log("Package manager: " + detection.packageManager);
  console.log(
    "Technologies: " + (detection.technologies.length ? detection.technologies.join(", ") : "none"),
  );
  console.log("Capabilities:");

  for (const capability of detection.capabilities) {
    const marker = capability.available ? "✓" : "·";
    const command = capability.command ? " -> " + capability.command : "";
    console.log("  " + marker + " " + capability.name + command);
  }
}

function printWorkflow(run: WorkflowRun): void {
  console.log("Workflow: " + run.runId);
  console.log("Task: " + run.taskRef);
  console.log("State: " + run.state);
  console.log("Updated: " + run.updatedAt);
  console.log("Checkpoints: " + run.checkpoints.length);
}

async function workflowStore(root: string): Promise<WorkflowStateStore> {
  const config = await loadAgentConfig(root);
  return new WorkflowStateStore(root, config);
}

program
  .name("llmatic")
  .description("Universal local software-engineering runtime for coding agents.")
  .version("0.1.0");

program
  .command("detect")
  .description("Detect repository technologies and executable engineering capabilities.")
  .option("-r, --root <path>", "Repository root", process.cwd())
  .option("--json", "Print machine-readable JSON")
  .action(async (options: { root: string; json?: boolean }) => {
    const detection = await detectRepository(resolve(options.root));

    if (options.json) {
      console.log(JSON.stringify(detection, null, 2));
      return;
    }

    printDetection(detection);
  });

program
  .command("init")
  .description("Initialize LLMatic runtime configuration in a repository.")
  .option("-r, --root <path>", "Repository root", process.cwd())
  .action(async (options: { root: string }) => {
    const root = resolve(options.root);
    const detection = await detectRepository(root);
    const config = createDefaultConfig(detection);

    await mkdir(resolve(root, ".llmatic/state"), { recursive: true });
    await mkdir(resolve(root, ".llmatic/cache"), { recursive: true });

    await writeFile(resolve(root, ".llmatic/.gitignore"), "*\n!.gitignore\n", {
      flag: "wx",
    }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") {
        throw error;
      }
    });

    await writeFile(resolve(root, "llmatic.agent.yaml"), serializeConfig(config), {
      flag: "wx",
    }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "EEXIST") {
        throw new Error("llmatic.agent.yaml already exists; refusing to overwrite it.");
      }
      throw error;
    });

    console.log("LLMatic Agent Runtime initialized.");
    console.log("");
    printDetection(detection);
    console.log("");
    console.log("Created: llmatic.agent.yaml");
    console.log("Created: .llmatic/");
  });

program
  .command("doctor")
  .description("Validate the local runtime, repository, and required toolchain.")
  .option("-r, --root <path>", "Repository root", process.cwd())
  .action(async (options: { root: string }) => {
    const report = await runDoctor(resolve(options.root));

    console.log("LLMatic Agent Runtime Doctor");
    console.log("Repository: " + report.root);
    console.log("");

    for (const item of report.checks) {
      console.log("[" + item.status + "] " + item.name + ": " + item.detail);
    }

    console.log("");
    console.log(report.ready ? "READY" : "NOT READY");

    if (!report.ready) {
      process.exitCode = 1;
    }
  });

program
  .command("run")
  .description("Execute a detected repository capability.")
  .argument("<capability>", "Capability: " + ["format", "lint", "typecheck", "test", "build", "ci"].join(", "))
  .option("-r, --root <path>", "Repository root", process.cwd())
  .option("--approve", "Approve capabilities configured with permission 'ask'")
  .action(async (capabilityInput: string, options: { root: string; approve?: boolean }) => {
    const root = resolve(options.root);
    const capability = capabilityInput as CapabilityName;
    const allowed: CapabilityName[] = ["format", "lint", "typecheck", "test", "build", "ci"];

    if (!allowed.includes(capability)) {
      throw new Error("Unknown capability: " + capabilityInput + ".");
    }

    const config = await loadAgentConfig(root);
    const result = await executeCapability(root, config, capability, {
      approved: options.approve ?? false,
    });

    const store = new WorkflowStateStore(root, config);
    await recordCapabilityCheckpoint(store, result);

    console.log("");
    console.log(
      (result.success ? "PASS" : "FAIL") +
        ": " +
        result.capability +
        " (" +
        result.durationMs +
        "ms)",
    );

    if (!result.success) {
      process.exitCode = result.exitCode || 1;
    }
  });

const workflow = program.command("workflow").description("Manage persistent workflow state.");

workflow
  .command("start")
  .description("Start a new workflow run.")
  .requiredOption("--task <reference>", "Task or work-item reference")
  .option("-r, --root <path>", "Repository root", process.cwd())
  .action(async (options: { task: string; root: string }) => {
    const root = resolve(options.root);
    const store = await workflowStore(root);
    const run = await startWorkflow(store, options.task);
    printWorkflow(run);
  });

workflow
  .command("status")
  .description("Show the active workflow state.")
  .option("-r, --root <path>", "Repository root", process.cwd())
  .option("--json", "Print machine-readable JSON")
  .action(async (options: { root: string; json?: boolean }) => {
    const root = resolve(options.root);
    const store = await workflowStore(root);
    const run = await store.loadCurrent();

    if (!run) {
      console.log(options.json ? "null" : "No workflow is active.");
      return;
    }

    if (options.json) {
      console.log(JSON.stringify(run, null, 2));
      return;
    }

    printWorkflow(run);
  });

workflow
  .command("transition")
  .description("Move the active workflow to a valid next state.")
  .argument("<state>", "Target state: " + WORKFLOW_STATES.join(", "))
  .option("-r, --root <path>", "Repository root", process.cwd())
  .action(async (stateInput: string, options: { root: string }) => {
    const root = resolve(options.root);
    const store = await workflowStore(root);
    const state = normalizeWorkflowState(stateInput);
    const run = await transitionWorkflow(store, state);
    printWorkflow(run);
  });

program
  .command("status")
  .description("Alias for workflow status.")
  .option("-r, --root <path>", "Repository root", process.cwd())
  .option("--json", "Print machine-readable JSON")
  .action(async (options: { root: string; json?: boolean }) => {
    const root = resolve(options.root);
    const store = await workflowStore(root);
    const run = await store.loadCurrent();

    if (!run) {
      console.log(options.json ? "null" : "No workflow is active.");
      return;
    }

    console.log(options.json ? JSON.stringify(run, null, 2) : "");
    if (!options.json) {
      printWorkflow(run);
    }
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error("llmatic: " + message);
  process.exitCode = 1;
});
