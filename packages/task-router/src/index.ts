import type { AgentConfig, WorkflowRun, WorkflowStateStore } from "@llmatic/core";
import type { TaskProvider, TaskRecord, TaskTransition } from "@llmatic/task-provider";
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

  const selected =
    candidates
      .filter((candidate) => candidate.available)
      .sort((left, right) => right.priority - left.priority)[0]?.id ?? "manual";

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
