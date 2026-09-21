import { spawnSync } from "node:child_process";
import type { AgentConfig } from "@llmatic/core";
import {
  assertTaskPermission,
  type TaskLifecycleStatus,
  type TaskProvider,
  type TaskProviderOperationOptions,
  type TaskRecord,
  type TaskTransition,
} from "@llmatic/task-provider";

export interface GitHubTaskProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type GitHubTaskProcessRunner = (
  executable: string,
  args: string[],
  cwd: string,
) => GitHubTaskProcessResult;

function defaultRunner(
  executable: string,
  args: string[],
  cwd: string,
): GitHubTaskProcessResult {
  const result = spawnSync(executable, args, {
    cwd,
    env: process.env,
    encoding: "utf8",
    shell: false,
  });

  if (result.error) {
    return {
      exitCode: 127,
      stdout: "",
      stderr: result.error.message,
    };
  }

  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function run(
  root: string,
  args: string[],
  runner: GitHubTaskProcessRunner,
): GitHubTaskProcessResult {
  return runner("gh", args, root);
}

function requireSuccess(
  result: GitHubTaskProcessResult,
  args: string[],
): GitHubTaskProcessResult {
  if (result.exitCode !== 0) {
    const detail = (result.stderr || result.stdout).trim();
    throw new Error(
      "GitHub task command failed: gh " +
        args.join(" ") +
        " (exit " +
        result.exitCode +
        ")" +
        (detail ? ": " + detail : ""),
    );
  }

  return result;
}

function parseJson<T>(result: GitHubTaskProcessResult, args: string[]): T {
  try {
    return JSON.parse(result.stdout) as T;
  } catch (error) {
    throw new Error(
      "GitHub CLI returned invalid issue JSON for gh " +
        args.join(" ") +
        ": " +
        (error instanceof Error ? error.message : String(error)),
    );
  }
}

function section(body: string, names: readonly string[]): string | undefined {
  const lines = body.split(/\r?\n/);
  let active = false;
  const collected: string[] = [];

  for (const line of lines) {
    const heading = /^#{2,4}\s+(.+?)\s*$/.exec(line);

    if (heading) {
      if (active) break;
      active = names.some(
        (name) => name.toLowerCase() === heading[1]!.trim().toLowerCase(),
      );
      continue;
    }

    if (active) collected.push(line);
  }

  const value = collected.join("\n").trim();
  return value || undefined;
}

function bullets(text: string | undefined): string[] {
  if (!text?.trim()) return [];

  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) =>
      line
        .replace(/^[-*+]\s+/, "")
        .replace(/^\d+[.)]\s+/, "")
        .replace(/^- \[[ xX]\]\s+/, "")
        .trim(),
    )
    .filter(Boolean);
}

function lifecycle(state: string, labels: string[]): TaskLifecycleStatus {
  if (state.toUpperCase() === "CLOSED") return "done";

  const normalizedLabels = labels.map((label) => label.toLowerCase());

  if (normalizedLabels.some((label) => label.includes("block"))) {
    return "blocked";
  }

  if (
    normalizedLabels.some(
      (label) =>
        label.includes("in progress") ||
        label.includes("in-progress") ||
        label === "doing" ||
        label === "active",
    )
  ) {
    return "in_progress";
  }

  return "todo";
}

function issueTask(raw: Record<string, unknown>): TaskRecord {
  const number = Number(raw.number);
  const title = String(raw.title ?? "").trim();
  const state = String(raw.state ?? "").trim();
  const body = typeof raw.body === "string" ? raw.body : "";
  const rawLabels = Array.isArray(raw.labels) ? raw.labels : [];
  const labels = rawLabels
    .map((item) =>
      typeof item === "string"
        ? item
        : item && typeof item === "object" && typeof (item as Record<string, unknown>).name === "string"
          ? String((item as Record<string, unknown>).name)
          : "",
    )
    .filter(Boolean);
  const rawAssignees = Array.isArray(raw.assignees) ? raw.assignees : [];
  const assignee = rawAssignees
    .map((item) =>
      item && typeof item === "object"
        ? String(
            (item as Record<string, unknown>).name ??
              (item as Record<string, unknown>).login ??
              "",
          )
        : "",
    )
    .filter(Boolean)
    .join(", ");

  if (!Number.isInteger(number) || number <= 0 || !title || !state) {
    throw new Error("GitHub issue JSON is missing number, title, or state.");
  }

  let dependencies = bullets(section(body, ["Dependencies", "Depends on", "Dependency"]));
  if (dependencies.length === 1 && dependencies[0]!.includes(",")) {
    dependencies = dependencies[0]!
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
  }

  return {
    provider: "github",
    id: String(number),
    key: "#" + number,
    summary: title,
    description: body || undefined,
    status: {
      id: state.toLowerCase(),
      name: state,
      category: state,
      lifecycle: lifecycle(state, labels),
    },
    assignee: assignee || undefined,
    labels,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : undefined,
    webUrl: typeof raw.url === "string" ? raw.url : undefined,
    acceptanceCriteria: bullets(
      section(body, ["Acceptance criteria", "Acceptance Criteria", "AC"]),
    ),
    definitionOfDone: bullets(
      section(body, ["DoD", "Definition of Done", "Definition Of Done"]),
    ),
    dependencies,
    source: {
      type: "github",
      location: typeof raw.url === "string" ? raw.url : undefined,
    },
  };
}

function referenceValue(reference: string): string {
  const value = reference.trim().replace(/^#/, "");
  if (!/^\d+$/.test(value)) {
    throw new Error("GitHub issue reference must be a numeric issue number.");
  }
  return value;
}

const ISSUE_FIELDS = "number,title,body,state,labels,assignees,url,updatedAt";

export class GitHubIssueTaskProvider implements TaskProvider {
  public readonly id = "github";

  public constructor(
    private readonly root: string,
    private readonly runtimeConfig: AgentConfig,
    private readonly runner: GitHubTaskProcessRunner = defaultRunner,
  ) {}

  public async getTask(
    reference: string,
    options: TaskProviderOperationOptions = {},
  ): Promise<TaskRecord> {
    assertTaskPermission(this.runtimeConfig, "read", options.approved ?? false);
    const args = ["issue", "view", referenceValue(reference), "--json", ISSUE_FIELDS];
    const result = requireSuccess(run(this.root, args, this.runner), args);
    return issueTask(parseJson<Record<string, unknown>>(result, args));
  }

  public async listTasks(
    options: TaskProviderOperationOptions = {},
  ): Promise<TaskRecord[]> {
    assertTaskPermission(this.runtimeConfig, "read", options.approved ?? false);
    const args = [
      "issue",
      "list",
      "--state",
      "all",
      "--limit",
      "200",
      "--json",
      ISSUE_FIELDS,
    ];
    const result = requireSuccess(run(this.root, args, this.runner), args);
    return parseJson<Array<Record<string, unknown>>>(result, args).map(issueTask);
  }

  public async getNextTask(
    options: TaskProviderOperationOptions = {},
  ): Promise<TaskRecord | undefined> {
    const tasks = await this.listTasks(options);
    const byReference = new Map<string, TaskRecord>();

    for (const task of tasks) {
      byReference.set(task.key.toLowerCase(), task);
      byReference.set(task.id.toLowerCase(), task);
    }

    return tasks.find((task) => {
      if (task.status.lifecycle !== "todo") return false;

      return task.dependencies.every((dependency) => {
        const normalized = dependency.trim().toLowerCase();
        const issueReference = normalized.match(/#(\d+)/)?.[1];
        const required =
          byReference.get(normalized) ??
          (issueReference ? byReference.get(issueReference) : undefined);

        return Boolean(required && required.status.lifecycle === "done");
      });
    });
  }

  public async listTransitions(
    reference: string,
    options: TaskProviderOperationOptions = {},
  ): Promise<TaskTransition[]> {
    const task = await this.getTask(reference, options);

    if (task.status.lifecycle === "done") {
      return [{ id: "reopen", name: "Reopen", toStatus: "OPEN" }];
    }

    return [{ id: "complete", name: "Complete", toStatus: "CLOSED" }];
  }

  public async addComment(
    reference: string,
    text: string,
    options: TaskProviderOperationOptions = {},
  ): Promise<void> {
    assertTaskPermission(this.runtimeConfig, "write", options.approved ?? false);
    const comment = text.trim();
    if (!comment) throw new Error("GitHub issue comment must not be empty.");

    const args = [
      "issue",
      "comment",
      referenceValue(reference),
      "--body",
      comment,
    ];
    requireSuccess(run(this.root, args, this.runner), args);
  }

  public async transitionTask(
    reference: string,
    transitionInput: string,
    options: TaskProviderOperationOptions = {},
  ): Promise<TaskTransition> {
    assertTaskPermission(this.runtimeConfig, "write", options.approved ?? false);
    const available = await this.listTransitions(reference, {
      approved: options.approved,
    });
    const normalized = transitionInput.trim().toLowerCase();
    const transition = available.find(
      (candidate) =>
        candidate.id.toLowerCase() === normalized ||
        candidate.name.toLowerCase() === normalized,
    );

    if (!transition) {
      throw new Error(
        "GitHub issue transition " +
          transitionInput +
          " is not available. Available: " +
          available.map((candidate) => candidate.name).join(", "),
      );
    }

    const args =
      transition.id === "reopen"
        ? ["issue", "reopen", referenceValue(reference)]
        : ["issue", "close", referenceValue(reference)];

    requireSuccess(run(this.root, args, this.runner), args);
    return transition;
  }
}

export function isGitHubIssueTaskSourceAvailable(
  root: string,
  runner: GitHubTaskProcessRunner = defaultRunner,
): boolean {
  const remote = runner("git", ["remote", "get-url", "origin"], root);

  if (remote.exitCode !== 0 || !/github\.com[:/]/i.test(remote.stdout.trim())) {
    return false;
  }

  const gh = runner("gh", ["auth", "status"], root);
  return gh.exitCode === 0;
}

export function createGitHubIssueTaskProvider(
  root: string,
  runtimeConfig: AgentConfig,
  runner?: GitHubTaskProcessRunner,
): GitHubIssueTaskProvider {
  return new GitHubIssueTaskProvider(root, runtimeConfig, runner);
}
