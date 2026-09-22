import type { AgentConfig, WorkflowRun, WorkflowStateStore } from "@llmatic/core";
import { recordActionCheckpoint, startWorkflow, transitionWorkflow } from "@llmatic/core";

export interface TaskProviderOperationOptions {
  approved?: boolean;
}

export type TaskLifecycleStatus = "todo" | "in_progress" | "blocked" | "done" | "unknown";

export interface TaskStatus {
  id: string;
  name: string;
  category?: string;
  lifecycle: TaskLifecycleStatus;
}

export interface TaskSourceMetadata {
  type: string;
  location?: string;
}

export interface TaskRecord {
  provider: string;
  id: string;
  key: string;
  summary: string;
  description?: string;
  status: TaskStatus;
  issueType?: string;
  priority?: string;
  assignee?: string;
  labels: string[];
  updatedAt?: string;
  webUrl?: string;
  acceptanceCriteria: string[];
  definitionOfDone: string[];
  dependencies: string[];
  source: TaskSourceMetadata;
}

export interface TaskTransition {
  id: string;
  name: string;
  toStatus?: string;
}

export interface TaskProvider {
  readonly id: string;

  getTask(reference: string, options?: TaskProviderOperationOptions): Promise<TaskRecord>;

  listTasks?(options?: TaskProviderOperationOptions): Promise<TaskRecord[]>;

  getNextTask?(options?: TaskProviderOperationOptions): Promise<TaskRecord | undefined>;

  assertSelectableTask?(reference: string, options?: TaskProviderOperationOptions): Promise<void>;

  listTransitions(
    reference: string,
    options?: TaskProviderOperationOptions,
  ): Promise<TaskTransition[]>;

  addComment(
    reference: string,
    text: string,
    options?: TaskProviderOperationOptions,
  ): Promise<void>;

  transitionTask(
    reference: string,
    transition: string,
    options?: TaskProviderOperationOptions,
  ): Promise<TaskTransition>;
}

export interface TaskWorkflowSyncOptions extends TaskProviderOperationOptions {
  comment?: string;
  transition?: string;
}

export function assertTaskPermission(
  config: AgentConfig,
  kind: "read" | "write",
  approved: boolean,
): void {
  const value = kind === "read" ? config.permissions.taskRead : config.permissions.taskWrite;
  const label = kind === "read" ? "Task read" : "Task write";

  if (value === "deny") {
    throw new Error(label + " is denied by llmatic.agent.yaml.");
  }

  if (value === "ask" && !approved) {
    throw new Error(
      label + " requires approval. Re-run with --approve after reviewing the operation.",
    );
  }
}

export function normalizeTaskLifecycleStatus(name: string, category?: string): TaskLifecycleStatus {
  const value = (category ?? name).trim().toLowerCase().replaceAll("-", " ").replaceAll("_", " ");

  if (
    ["done", "complete", "completed", "closed", "resolved"].some((item) => value.includes(item))
  ) {
    return "done";
  }

  if (value.includes("block")) return "blocked";

  if (
    ["in progress", "doing", "active", "started", "working"].some((item) => value.includes(item))
  ) {
    return "in_progress";
  }

  if (
    ["todo", "to do", "open", "backlog", "new", "selected for development"].some((item) =>
      value.includes(item),
    )
  ) {
    return "todo";
  }

  return "unknown";
}

function taskMetadata(task: TaskRecord): Record<string, string> {
  const metadata: Record<string, string> = {
    provider: task.provider,
    taskId: task.id,
    taskKey: task.key,
    status: task.status.name,
    lifecycle: task.status.lifecycle,
  };

  if (task.updatedAt) metadata.updatedAt = task.updatedAt;
  if (task.webUrl) metadata.url = task.webUrl;
  if (task.source.location) metadata.sourceLocation = task.source.location;
  return metadata;
}

export async function selectWorkflowTask(
  store: WorkflowStateStore,
  provider: TaskProvider,
  reference: string,
  options: TaskProviderOperationOptions = {},
): Promise<{ task: TaskRecord; workflow: WorkflowRun }> {
  await provider.assertSelectableTask?.(reference, options);
  const task = await provider.getTask(reference, options);
  let workflow = await startWorkflow(store, task.key);

  await recordActionCheckpoint(store, {
    provider: provider.id,
    action: "task.select",
    success: true,
    detail: task.summary,
    metadata: taskMetadata(task),
  });

  workflow = (await store.loadCurrent()) ?? workflow;
  return { task, workflow };
}

export async function validateWorkflowTask(
  store: WorkflowStateStore,
  provider: TaskProvider,
  options: TaskProviderOperationOptions = {},
): Promise<{ task: TaskRecord; workflow: WorkflowRun }> {
  const current = await store.loadCurrent();

  if (!current || current.state !== "TASK_SELECTED") {
    throw new Error("Task validation requires workflow state TASK_SELECTED.");
  }

  try {
    await provider.assertSelectableTask?.(current.taskRef, options);
    const task = await provider.getTask(current.taskRef, options);

    await recordActionCheckpoint(store, {
      provider: provider.id,
      action: "task.validate",
      success: true,
      detail: task.summary,
      metadata: taskMetadata(task),
    });

    const workflow = await transitionWorkflow(store, "TASK_VALIDATED");
    return { task, workflow };
  } catch (error) {
    await recordActionCheckpoint(store, {
      provider: provider.id,
      action: "task.validate",
      success: false,
      detail: error instanceof Error ? error.message : String(error),
      metadata: { taskKey: current.taskRef },
    });
    throw error;
  }
}

export async function syncWorkflowTask(
  store: WorkflowStateStore,
  provider: TaskProvider,
  options: TaskWorkflowSyncOptions,
): Promise<{
  taskRef: string;
  commentAdded: boolean;
  transition?: TaskTransition;
}> {
  const current = await store.loadCurrent();
  if (!current) throw new Error("No workflow is active.");

  const comment = options.comment?.trim();
  const transitionInput = options.transition?.trim();

  if (!comment && !transitionInput) {
    throw new Error("Task sync requires a comment and/or transition.");
  }

  try {
    if (comment) {
      await provider.addComment(current.taskRef, comment, options);
    }

    const transition = transitionInput
      ? await provider.transitionTask(current.taskRef, transitionInput, options)
      : undefined;

    await recordActionCheckpoint(store, {
      provider: provider.id,
      action: "task.sync",
      success: true,
      detail: [
        comment ? "comment" : undefined,
        transition ? "transition " + transition.name : undefined,
      ]
        .filter(Boolean)
        .join(", "),
      metadata: {
        taskKey: current.taskRef,
        ...(transition ? { transitionId: transition.id } : {}),
      },
    });

    return {
      taskRef: current.taskRef,
      commentAdded: Boolean(comment),
      transition,
    };
  } catch (error) {
    await recordActionCheckpoint(store, {
      provider: provider.id,
      action: "task.sync",
      success: false,
      detail: error instanceof Error ? error.message : String(error),
      metadata: { taskKey: current.taskRef },
    });
    throw error;
  }
}
