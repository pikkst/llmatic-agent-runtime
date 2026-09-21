import type { AgentConfig } from "./config.js";
import { executeCapability, type CapabilityProcessRunner } from "./executor.js";
import type { CapabilityExecutionResult, CapabilityName } from "./types.js";
import {
  WorkflowStateStore,
  recordCapabilityCheckpoint,
  transitionWorkflow,
  type WorkflowState,
} from "./workflow.js";

const VALIDATION_CAPABILITIES: readonly CapabilityName[] = [
  "format",
  "lint",
  "typecheck",
  "test",
  "build",
];

export interface LocalValidationOptions {
  approved?: boolean;
  runner?: CapabilityProcessRunner;
}

export interface LocalValidationReport {
  runId: string;
  startedState: WorkflowState;
  finishedState: WorkflowState;
  success: boolean;
  results: CapabilityExecutionResult[];
}

function validationCapability(input: string): CapabilityName {
  if (!VALIDATION_CAPABILITIES.includes(input as CapabilityName)) {
    throw new Error(
      "Unsupported required validation gate: " +
        input +
        ". Allowed gates: " +
        VALIDATION_CAPABILITIES.join(", ") +
        ".",
    );
  }

  return input as CapabilityName;
}

export async function runLocalValidation(
  root: string,
  config: AgentConfig,
  store: WorkflowStateStore,
  options: LocalValidationOptions = {},
): Promise<LocalValidationReport> {
  const current = await store.loadCurrent();

  if (!current) {
    throw new Error("No workflow is active. Start one with llmatic workflow start.");
  }

  const startedState = current.state;
  let active = current;

  if (active.state === "IMPLEMENTING" || active.state === "FIXING") {
    active = await transitionWorkflow(store, "LOCAL_VALIDATION");
  } else if (active.state !== "LOCAL_VALIDATION") {
    throw new Error(
      "Local validation requires workflow state IMPLEMENTING, FIXING, or LOCAL_VALIDATION. Current state: " +
        active.state +
        ".",
    );
  }

  const results: CapabilityExecutionResult[] = [];

  for (const configuredGate of config.workflow.requiredGates) {
    const capability = validationCapability(configuredGate);
    const result = await executeCapability(root, config, capability, {
      approved: options.approved ?? false,
      runner: options.runner,
    });

    results.push(result);
    await recordCapabilityCheckpoint(store, result);

    if (!result.success) {
      const failed = await transitionWorkflow(store, "FIXING");

      return {
        runId: failed.runId,
        startedState,
        finishedState: failed.state,
        success: false,
        results,
      };
    }
  }

  const completed = await transitionWorkflow(store, "CODE_REVIEW");

  return {
    runId: completed.runId,
    startedState,
    finishedState: completed.state,
    success: true,
    results,
  };
}
