import type { AgentConfig, WorkflowRun, WorkflowStateStore } from "@llmatic/core";
import {
  selectWorkflowTask,
  validateWorkflowTask,
  type TaskProvider,
  type TaskRecord,
  type TaskTransition,
} from "@llmatic/task-provider";
import { createMarkdownTaskProvider, detectMarkdownTaskFile } from "@llmatic/markdown-task-source";
import { createJiraTaskProviderFromEnvironment } from "@llmatic/jira-adapter";
import {
  createGitHubIssueTaskProvider,
  isGitHubIssueTaskSourceAvailable,
} from "@llmatic/github-task-source";

export type TaskProviderId = "auto" | "markdown" | "jira" | "github" | "manual";

export interface TaskSourceCandidate {
  id: Exclude<TaskProviderId, "auto">;
  available: boolean;
  detail: string;
  priority: number;
}

export interface TaskSourceDetection {
  selected: Exclude<TaskProviderId, "auto">;
  candidates: TaskSourceCandidate[];
}

class ManualTaskProvider implements TaskProvider {
  public readonly id = "manual";

  public async getTask(reference: string): Promise<TaskRecord> {
    const key = reference.trim();

    if (!key) {
      throw new Error("Manual task reference must not be empty.");
    }

    return {
      provider: "manual",
      id: key,
      key,
      summary: key,
      status: {
        id: "todo",
        name: "Todo",
        lifecycle: "todo",
      },
      labels: [],
      acceptanceCriteria: [],
      definitionOfDone: [],
      dependencies: [],
      source: {
        type: "manual",
      },
    };
  }

  public async listTransitions(): Promise<TaskTransition[]> {
    return [];
  }

  public async addComment(): Promise<void> {
    throw new Error("Manual task source has no external comment target.");
  }

  public async transitionTask(): Promise<TaskTransition> {
    throw new Error("Manual task source has no external transition target.");
  }
}

function jiraConfigured(environment: NodeJS.ProcessEnv): boolean {
  const base = environment.LLMATIC_JIRA_BASE_URL?.trim();
  const bearer = environment.LLMATIC_JIRA_BEARER_TOKEN?.trim();
  const basic =
    environment.LLMATIC_JIRA_EMAIL?.trim() && environment.LLMATIC_JIRA_API_TOKEN?.trim();

  return Boolean(base && (bearer || basic));
}

export async function detectTaskSources(
  root: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<TaskSourceDetection> {
  const markdown = await detectMarkdownTaskFile(root);
  const hasJira = jiraConfigured(environment);
  const hasGitHub = isGitHubIssueTaskSourceAvailable(root);

  const candidates: TaskSourceCandidate[] = [
    {
      id: "markdown",
      available: Boolean(markdown),
      detail: markdown ?? "No Markdown task file found.",
      priority: 100,
    },
    {
      id: "jira",
      available: hasJira,
      detail: hasJira
        ? "Jira environment configuration detected."
        : "Jira environment configuration not detected.",
      priority: 80,
    },
    {
      id: "github",
      available: hasGitHub,
      detail: hasGitHub
        ? "GitHub origin and authenticated GitHub CLI detected."
        : "GitHub Issues source is not available.",
      priority: 60,
    },
    {
      id: "manual",
      available: true,
      detail: "Manual workflow task references are always available.",
      priority: 0,
    },
  ];

  const preferred = environment.LLMATIC_TASK_PROVIDER?.trim().toLowerCase();
  const preferredCandidate =
    preferred && preferred !== "auto"
      ? candidates.find((candidate) => candidate.id === preferred && candidate.available)
      : undefined;

  const selected =
    preferredCandidate?.id ??
    candidates
      .filter((candidate) => candidate.available)
      .sort((left, right) => right.priority - left.priority)[0]?.id ??
    "manual";

  return {
    selected,
    candidates,
  };
}

export async function resolveTaskProvider(
  root: string,
  config: AgentConfig,
  providerInput: TaskProviderId = "auto",
  environment: NodeJS.ProcessEnv = process.env,
): Promise<TaskProvider> {
  const providerId =
    providerInput === "auto"
      ? (await detectTaskSources(root, environment)).selected
      : providerInput;

  if (providerId === "markdown") {
    return createMarkdownTaskProvider(root, config);
  }

  if (providerId === "jira") {
    return createJiraTaskProviderFromEnvironment(config, environment);
  }

  if (providerId === "github") {
    return createGitHubIssueTaskProvider(root, config);
  }

  if (providerId === "manual") {
    return new ManualTaskProvider();
  }

  throw new Error("Unsupported task provider: " + providerId + ".");
}

export interface TaskReferenceResolutionMatch {
  provider: string;
  task: TaskRecord;
}

export interface TaskReferenceResolutionFailure {
  provider: string;
  reason: string;
}

export type TaskReferenceResolution =
  | {
      status: "resolved";
      reference: string;
      match: TaskReferenceResolutionMatch;
      attemptedProviders: string[];
    }
  | {
      status: "not_found";
      reference: string;
      attemptedProviders: string[];
    }
  | {
      status: "ambiguous";
      reference: string;
      matches: TaskReferenceResolutionMatch[];
      attemptedProviders: string[];
    }
  | {
      status: "unavailable";
      reference: string;
      matches: TaskReferenceResolutionMatch[];
      failures: TaskReferenceResolutionFailure[];
      attemptedProviders: string[];
    };

function taskReferenceNotFound(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\b(?:404|not found|was not found|could not resolve to an issue|does not exist)\b/i.test(
    message,
  );
}

export async function resolveTaskReferenceFromProviders(
  reference: string,
  providers: TaskProvider[],
): Promise<TaskReferenceResolution> {
  const normalized = reference.trim();
  if (!normalized) {
    throw new Error("Task reference must not be empty.");
  }

  const attemptedProviders: string[] = [];
  const matches: TaskReferenceResolutionMatch[] = [];
  const failures: TaskReferenceResolutionFailure[] = [];

  for (const provider of providers) {
    if (provider.id === "manual") continue;
    attemptedProviders.push(provider.id);

    try {
      const task = await provider.getTask(normalized);
      matches.push({ provider: provider.id, task });
    } catch (error) {
      if (taskReferenceNotFound(error)) continue;
      failures.push({
        provider: provider.id,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (failures.length > 0) {
    return {
      status: "unavailable",
      reference: normalized,
      matches,
      failures,
      attemptedProviders,
    };
  }

  if (matches.length > 1) {
    return {
      status: "ambiguous",
      reference: normalized,
      matches,
      attemptedProviders,
    };
  }

  if (matches.length === 1) {
    return {
      status: "resolved",
      reference: normalized,
      match: matches[0]!,
      attemptedProviders,
    };
  }

  return {
    status: "not_found",
    reference: normalized,
    attemptedProviders,
  };
}

function providerSupportsReference(providerId: string, reference: string): boolean {
  const value = reference.trim();
  if (providerId === "github") return /^#?\d+$/.test(value);
  if (providerId === "jira" || providerId === "markdown") {
    return /^[A-Za-z][A-Za-z0-9_.-]*-\d+$/.test(value);
  }
  return false;
}

export async function resolveTaskReference(
  root: string,
  config: AgentConfig,
  reference: string,
  providerInput: TaskProviderId = "auto",
  environment: NodeJS.ProcessEnv = process.env,
): Promise<TaskReferenceResolution> {
  if (providerInput === "manual") {
    return {
      status: "not_found",
      reference: reference.trim(),
      attemptedProviders: [],
    };
  }

  if (providerInput !== "auto") {
    if (!providerSupportsReference(providerInput, reference)) {
      return {
        status: "not_found",
        reference: reference.trim(),
        attemptedProviders: [],
      };
    }
    const provider = await resolveTaskProvider(root, config, providerInput, environment);
    return resolveTaskReferenceFromProviders(reference, [provider]);
  }

  const detection = await detectTaskSources(root, environment);
  const candidates = detection.candidates
    .filter(
      (candidate) =>
        candidate.available &&
        candidate.id !== "manual" &&
        providerSupportsReference(candidate.id, reference),
    )
    .sort((left, right) => right.priority - left.priority);

  const providers: TaskProvider[] = [];
  for (const candidate of candidates) {
    providers.push(await resolveTaskProvider(root, config, candidate.id, environment));
  }

  return resolveTaskReferenceFromProviders(reference, providers);
}

function workflowProviderId(
  run: WorkflowRun | undefined,
): Exclude<TaskProviderId, "auto"> | undefined {
  if (!run) return undefined;

  for (let index = run.checkpoints.length - 1; index >= 0; index -= 1) {
    const checkpoint = run.checkpoints[index];

    if (
      checkpoint?.kind === "ACTION" &&
      checkpoint.action === "task.select" &&
      (checkpoint.provider === "markdown" ||
        checkpoint.provider === "jira" ||
        checkpoint.provider === "github" ||
        checkpoint.provider === "manual")
    ) {
      return checkpoint.provider;
    }
  }

  return undefined;
}

export async function resolveWorkflowTaskProvider(
  root: string,
  config: AgentConfig,
  store: WorkflowStateStore,
  providerInput: TaskProviderId = "auto",
  environment: NodeJS.ProcessEnv = process.env,
): Promise<TaskProvider> {
  if (providerInput !== "auto") {
    return resolveTaskProvider(root, config, providerInput, environment);
  }

  const current = await store.loadCurrent();
  const selected = workflowProviderId(current);

  return resolveTaskProvider(root, config, selected ?? "auto", environment);
}

export async function startTaskWorkflow(
  root: string,
  config: AgentConfig,
  store: WorkflowStateStore,
  options: {
    provider?: TaskProviderId;
    reference?: string;
    environment?: NodeJS.ProcessEnv;
  } = {},
): Promise<{ task: TaskRecord; workflow: WorkflowRun; provider: string }> {
  const environment = options.environment ?? process.env;
  const provider = await resolveTaskProvider(root, config, options.provider ?? "auto", environment);

  const task = options.reference?.trim()
    ? await provider.getTask(options.reference.trim())
    : provider.getNextTask
      ? await provider.getNextTask()
      : undefined;

  if (!task) {
    throw new Error("No actionable task could be resolved from provider " + provider.id + ".");
  }

  await selectWorkflowTask(store, provider, task.key);
  const validated = await validateWorkflowTask(store, provider);

  return {
    task: validated.task,
    workflow: validated.workflow,
    provider: provider.id,
  };
}
