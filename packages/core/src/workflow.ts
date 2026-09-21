import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import type { AgentConfig } from "./config.js";
import type { CapabilityExecutionResult } from "./types.js";

export const WORKFLOW_STATES = [
  "TASK_SELECTED",
  "TASK_VALIDATED",
  "REPO_ANALYZED",
  "BRANCH_CREATED",
  "IMPLEMENTING",
  "LOCAL_VALIDATION",
  "FIXING",
  "CODE_REVIEW",
  "READY_TO_PUSH",
  "PUSHED",
  "PR_OPEN",
  "REMOTE_CI",
  "FINAL_REVIEW",
  "READY_TO_MERGE",
  "COMPLETED",
  "FAILED",
] as const;

export const workflowStateSchema = z.enum(WORKFLOW_STATES);
export type WorkflowState = z.infer<typeof workflowStateSchema>;

const checkpointBaseSchema = z.object({
  id: z.string().uuid(),
  timestamp: z.string().datetime(),
});

const stateCheckpointSchema = checkpointBaseSchema.extend({
  kind: z.literal("STATE_TRANSITION"),
  from: workflowStateSchema.nullable(),
  to: workflowStateSchema,
});

const capabilityCheckpointSchema = checkpointBaseSchema.extend({
  kind: z.literal("CAPABILITY_RUN"),
  capability: z.string(),
  command: z.string(),
  exitCode: z.number().int(),
  success: z.boolean(),
  durationMs: z.number().nonnegative(),
});

const actionCheckpointSchema = checkpointBaseSchema.extend({
  kind: z.literal("ACTION"),
  provider: z.string().min(1),
  action: z.string().min(1),
  command: z.string().optional(),
  success: z.boolean(),
  detail: z.string().optional(),
});

export const workflowCheckpointSchema = z.discriminatedUnion("kind", [
  stateCheckpointSchema,
  capabilityCheckpointSchema,
  actionCheckpointSchema,
]);

export const workflowRunSchema = z.object({
  version: z.literal(1),
  runId: z.string().uuid(),
  taskRef: z.string().min(1),
  state: workflowStateSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  checkpoints: z.array(workflowCheckpointSchema),
});

export type WorkflowCheckpoint = z.infer<typeof workflowCheckpointSchema>;
export type WorkflowRun = z.infer<typeof workflowRunSchema>;

export interface ActionCheckpointInput {
  provider: string;
  action: string;
  command?: string;
  success: boolean;
  detail?: string;
}

const transitions: Record<WorkflowState, readonly WorkflowState[]> = {
  TASK_SELECTED: ["TASK_VALIDATED", "FAILED"],
  TASK_VALIDATED: ["REPO_ANALYZED", "FAILED"],
  REPO_ANALYZED: ["BRANCH_CREATED", "FAILED"],
  BRANCH_CREATED: ["IMPLEMENTING", "FAILED"],
  IMPLEMENTING: ["LOCAL_VALIDATION", "FIXING", "FAILED"],
  LOCAL_VALIDATION: ["CODE_REVIEW", "FIXING", "FAILED"],
  FIXING: ["LOCAL_VALIDATION", "CODE_REVIEW", "FAILED"],
  CODE_REVIEW: ["READY_TO_PUSH", "FIXING", "FAILED"],
  READY_TO_PUSH: ["PUSHED", "FAILED"],
  PUSHED: ["PR_OPEN", "FAILED"],
  PR_OPEN: ["REMOTE_CI", "FAILED"],
  REMOTE_CI: ["FINAL_REVIEW", "FIXING", "FAILED"],
  FINAL_REVIEW: ["READY_TO_MERGE", "FIXING", "FAILED"],
  READY_TO_MERGE: ["COMPLETED", "FAILED"],
  COMPLETED: [],
  FAILED: [],
};

export function normalizeWorkflowState(input: string): WorkflowState {
  const normalized = input.trim().toUpperCase().replaceAll("-", "_");
  return workflowStateSchema.parse(normalized);
}

export function canTransition(from: WorkflowState, to: WorkflowState): boolean {
  return transitions[from].includes(to);
}

async function replaceFile(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });

  const temporaryPath = path + "." + randomUUID() + ".tmp";
  await writeFile(temporaryPath, content, "utf8");

  try {
    await rename(temporaryPath, path);
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : undefined;

    if (code !== "EEXIST" && code !== "EPERM") {
      await rm(temporaryPath, { force: true });
      throw error;
    }

    await rm(path, { force: true });
    await rename(temporaryPath, path);
  }
}

export class WorkflowStateStore {
  private readonly stateRoot: string;
  private readonly currentPath: string;
  private readonly runsRoot: string;

  public constructor(root: string, config: AgentConfig) {
    this.stateRoot = resolve(root, config.runtime.stateDirectory);
    this.currentPath = resolve(this.stateRoot, "current.json");
    this.runsRoot = resolve(this.stateRoot, "runs");
  }

  public async loadCurrent(): Promise<WorkflowRun | undefined> {
    try {
      const raw = await readFile(this.currentPath, "utf8");
      return workflowRunSchema.parse(JSON.parse(raw));
    } catch (error) {
      const code = error instanceof Error && "code" in error ? String(error.code) : undefined;

      if (code === "ENOENT") {
        return undefined;
      }

      throw error;
    }
  }

  public async save(run: WorkflowRun): Promise<void> {
    const parsed = workflowRunSchema.parse(run);
    const serialized = JSON.stringify(parsed, null, 2) + "\n";
    const runPath = resolve(this.runsRoot, parsed.runId + ".json");

    await replaceFile(runPath, serialized);
    await replaceFile(this.currentPath, serialized);
  }
}

export async function startWorkflow(
  store: WorkflowStateStore,
  taskRef: string,
): Promise<WorkflowRun> {
  const current = await store.loadCurrent();

  if (current && current.state !== "COMPLETED" && current.state !== "FAILED") {
    throw new Error(
      "Workflow " +
        current.runId +
        " is still active in state " +
        current.state +
        ". Complete or fail it before starting another workflow.",
    );
  }

  const now = new Date().toISOString();
  const run: WorkflowRun = {
    version: 1,
    runId: randomUUID(),
    taskRef,
    state: "TASK_SELECTED",
    createdAt: now,
    updatedAt: now,
    checkpoints: [
      {
        id: randomUUID(),
        kind: "STATE_TRANSITION",
        timestamp: now,
        from: null,
        to: "TASK_SELECTED",
      },
    ],
  };

  await store.save(run);
  return run;
}

export async function transitionWorkflow(
  store: WorkflowStateStore,
  nextState: WorkflowState,
): Promise<WorkflowRun> {
  const current = await store.loadCurrent();

  if (!current) {
    throw new Error("No workflow is active. Start one with llmatic workflow start.");
  }

  if (!canTransition(current.state, nextState)) {
    throw new Error("Invalid workflow transition: " + current.state + " -> " + nextState + ".");
  }

  const now = new Date().toISOString();
  const updated: WorkflowRun = {
    ...current,
    state: nextState,
    updatedAt: now,
    checkpoints: [
      ...current.checkpoints,
      {
        id: randomUUID(),
        kind: "STATE_TRANSITION",
        timestamp: now,
        from: current.state,
        to: nextState,
      },
    ],
  };

  await store.save(updated);
  return updated;
}

export async function recordActionCheckpoint(
  store: WorkflowStateStore,
  input: ActionCheckpointInput,
): Promise<WorkflowRun | undefined> {
  const current = await store.loadCurrent();

  if (!current) {
    return undefined;
  }

  const now = new Date().toISOString();
  const updated: WorkflowRun = {
    ...current,
    updatedAt: now,
    checkpoints: [
      ...current.checkpoints,
      {
        id: randomUUID(),
        kind: "ACTION",
        timestamp: now,
        provider: input.provider,
        action: input.action,
        command: input.command,
        success: input.success,
        detail: input.detail,
      },
    ],
  };

  await store.save(updated);
  return updated;
}

export async function recordCapabilityCheckpoint(
  store: WorkflowStateStore,
  result: CapabilityExecutionResult,
): Promise<WorkflowRun | undefined> {
  const current = await store.loadCurrent();

  if (!current) {
    return undefined;
  }

  const now = new Date().toISOString();
  const updated: WorkflowRun = {
    ...current,
    updatedAt: now,
    checkpoints: [
      ...current.checkpoints,
      {
        id: randomUUID(),
        kind: "CAPABILITY_RUN",
        timestamp: now,
        capability: result.capability,
        command: result.command,
        exitCode: result.exitCode,
        success: result.success,
        durationMs: result.durationMs,
      },
    ],
  };

  await store.save(updated);
  return updated;
}
