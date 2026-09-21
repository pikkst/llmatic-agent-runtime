import type { AgentConfig } from "@llmatic/core";
import type {
  TaskProvider,
  TaskRecord,
  TaskTransition,
} from "@llmatic/task-provider";
import {
  createMarkdownTaskProvider,
  detectMarkdownTaskFile,
} from "@llmatic/markdown-task-source";
import { createJiraTaskProviderFromEnvironment } from "@llmatic/jira-adapter";

export type TaskProviderId = "auto" | "markdown" | "jira" | "manual";

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
    environment.LLMATIC_JIRA_EMAIL?.trim() &&
    environment.LLMATIC_JIRA_API_TOKEN?.trim();

  return Boolean(base && (bearer || basic));
}

export async function detectTaskSources(
  root: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<TaskSourceDetection> {
  const markdown = await detectMarkdownTaskFile(root);
  const hasJira = jiraConfigured(environment);

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

  if (providerId === "manual") {
    return new ManualTaskProvider();
  }

  throw new Error("Unsupported task provider: " + providerId + ".");
}
