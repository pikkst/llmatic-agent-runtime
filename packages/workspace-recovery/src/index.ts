import type { AgentConfig, WorkflowRun, WorkflowStateStore } from "@llmatic/core";
import { getGitStatus, type GitStatus } from "@llmatic/git-adapter";
import {
  getPullRequestStatus,
  type PullRequestStatus,
} from "@llmatic/github-adapter";
import {
  buildRepositoryIndex,
  loadRepositoryIndex,
  type RepositoryIndex,
} from "@llmatic/repo-intelligence";
import {
  buildRepositoryConstitution,
  repositoryConstitutionContext,
  type RepositoryConstitution,
} from "@llmatic/repository-constitution";
import type { TaskProvider, TaskRecord } from "@llmatic/task-provider";
import {
  detectTaskSources,
  resolveTaskProvider,
  resolveWorkflowTaskProvider,
  type TaskSourceDetection,
} from "@llmatic/task-router";

export type WorkspaceRecoveryAction =
  | "continue_workflow"
  | "fix_pr"
  | "wait_for_ci"
  | "review_pr"
  | "continue_task"
  | "start_task"
  | "continue_changes"
  | "start_discovery"
  | "ask_goal";

export interface WorkspaceRecoveryRecommendation {
  action: WorkspaceRecoveryAction;
  title: string;
  detail: string;
}

export interface RepositoryMapSummary {
  generatedAt: string;
  fileCount: number;
  sourceFileCount: number;
  symbolCount: number;
  importCount: number;
}

export interface WorkspaceRecovery {
  root: string;
  repository: RepositoryMapSummary;
  git: GitStatus;
  workflow?: WorkflowRun;
  taskSource: TaskSourceDetection;
  task?: TaskRecord;
  nextTask?: TaskRecord;
  taskCandidates: TaskRecord[];
  constitution: RepositoryConstitution;
  pullRequest?: PullRequestStatus;
  warnings: string[];
  recommendation: WorkspaceRecoveryRecommendation;
}

export interface RecoverWorkspaceOptions {
  rebuildIndex?: boolean;
  environment?: NodeJS.ProcessEnv;
}

function indexSummary(index: RepositoryIndex): RepositoryMapSummary {
  return {
    generatedAt: index.generatedAt,
    fileCount: index.fileCount,
    sourceFileCount: index.sourceFileCount,
    symbolCount: index.symbols.length,
    importCount: index.imports.length,
  };
}

function activeWorkflow(run: WorkflowRun | undefined): WorkflowRun | undefined {
  if (!run) return undefined;
  return run.state === "COMPLETED" || run.state === "FAILED" ? undefined : run;
}

function branchTaskReference(branch: string | undefined): string | undefined {
  if (!branch) return undefined;

  const jira = /(?:^|[/_-])([A-Z][A-Z0-9]+-\d+)(?:$|[/_-])/i.exec(branch);
  if (jira?.[1]) return jira[1].toUpperCase();

  const github = /(?:^|[/_-])(?:issue|gh|pr)[-_/]?(\d+)(?:$|[/_-])/i.exec(branch);
  return github?.[1] ? "#" + github[1] : undefined;
}

async function loadOrBuildRepositoryIndex(
  root: string,
  config: AgentConfig,
  rebuild: boolean,
): Promise<RepositoryIndex> {
  if (!rebuild) {
    try {
      return await loadRepositoryIndex(root, config);
    } catch {
      // First recovery for a repository is expected to build the private index.
    }
  }

  return buildRepositoryIndex(root, config);
}

async function providerTask(
  provider: TaskProvider,
  reference: string,
): Promise<TaskRecord | undefined> {
  try {
    return await provider.getTask(reference);
  } catch {
    return undefined;
  }
}

async function recoverWorkflowTask(
  root: string,
  config: AgentConfig,
  store: WorkflowStateStore,
  workflow: WorkflowRun,
  environment: NodeJS.ProcessEnv,
): Promise<TaskRecord | undefined> {
  try {
    const provider = await resolveWorkflowTaskProvider(
      root,
      config,
      store,
      "auto",
      environment,
    );
    return await providerTask(provider, workflow.taskRef);
  } catch {
    return undefined;
  }
}

async function recoverBranchTask(
  root: string,
  config: AgentConfig,
  detection: TaskSourceDetection,
  branch: string | undefined,
  environment: NodeJS.ProcessEnv,
): Promise<TaskRecord | undefined> {
  const reference = branchTaskReference(branch);
  if (!reference) return undefined;

  const available = detection.candidates
    .filter((candidate) => candidate.available && candidate.id !== "manual")
    .sort((left, right) => {
      if (reference.startsWith("#")) {
        if (left.id === "github") return -1;
        if (right.id === "github") return 1;
      } else {
        if (left.id === "jira") return -1;
        if (right.id === "jira") return 1;
      }
      return right.priority - left.priority;
    });

  for (const candidate of available) {
    try {
      const provider = await resolveTaskProvider(
        root,
        config,
        candidate.id,
        environment,
      );
      const task = await providerTask(provider, reference);
      if (task) return task;
    } catch {
      // Continue across available providers; branch recovery is best effort.
    }
  }

  return undefined;
}

async function recoverProviderTasks(
  root: string,
  config: AgentConfig,
  detection: TaskSourceDetection,
  environment: NodeJS.ProcessEnv,
): Promise<{ task?: TaskRecord; nextTask?: TaskRecord; candidates: TaskRecord[] }> {
  if (detection.selected === "manual") return { candidates: [] };

  try {
    const provider = await resolveTaskProvider(
      root,
      config,
      detection.selected,
      environment,
    );

    if (provider.listTasks) {
      const tasks = await provider.listTasks();
      const active = tasks.find((task) => task.status.lifecycle === "in_progress");
      if (active) {
        return {
          task: active,
          candidates: tasks
            .filter((task) => task.status.lifecycle !== "done")
            .slice(0, 10),
        };
      }

      if (provider.getNextTask) {
        return {
          nextTask: await provider.getNextTask(),
          candidates: tasks
            .filter((task) => task.status.lifecycle !== "done")
            .slice(0, 10),
        };
      }

      return {
        candidates: tasks
          .filter((task) => task.status.lifecycle !== "done")
          .slice(0, 10),
      };
    }

    if (provider.getNextTask) {
      const nextTask = await provider.getNextTask();
      return {
        nextTask,
        candidates: nextTask ? [nextTask] : [],
      };
    }
  } catch {
    // Recovery should still succeed when an optional external provider is unavailable.
  }

  return { candidates: [] };
}

async function recoverPullRequest(root: string): Promise<PullRequestStatus | undefined> {
  try {
    const status = await getPullRequestStatus(root);
    return status.pullRequest.state === "OPEN" ? status : undefined;
  } catch {
    return undefined;
  }
}

export function recommendWorkspaceAction(input: {
  repository: RepositoryMapSummary;
  git: GitStatus;
  workflow?: WorkflowRun;
  task?: TaskRecord;
  nextTask?: TaskRecord;
  pullRequest?: PullRequestStatus;
}): WorkspaceRecoveryRecommendation {
  const { repository, git, workflow, task, nextTask, pullRequest } = input;

  if (workflow) {
    if (pullRequest?.ciState === "failing" || pullRequest?.ciState === "cancelled") {
      return {
        action: "fix_pr",
        title: "Continue fixing the open pull request",
        detail:
          "Workflow " +
          workflow.taskRef +
          " is active and PR #" +
          pullRequest.pullRequest.number +
          " has failing CI.",
      };
    }

    if (pullRequest?.ciState === "pending") {
      return {
        action: "wait_for_ci",
        title: "Continue from the open pull request",
        detail:
          "PR #" +
          pullRequest.pullRequest.number +
          " is still running CI for workflow " +
          workflow.taskRef +
          ".",
      };
    }

    if (pullRequest?.ciState === "passing") {
      return {
        action: "review_pr",
        title: "Review the green pull request",
        detail:
          "PR #" +
          pullRequest.pullRequest.number +
          " is green; continue the workflow from " +
          workflow.state +
          ".",
      };
    }

    return {
      action: "continue_workflow",
      title: "Continue the active engineering workflow",
      detail: workflow.taskRef + " is currently in state " + workflow.state + ".",
    };
  }

  if (pullRequest) {
    if (pullRequest.ciState === "failing" || pullRequest.ciState === "cancelled") {
      return {
        action: "fix_pr",
        title: "Fix the current branch pull request",
        detail: "PR #" + pullRequest.pullRequest.number + " has failing CI.",
      };
    }

    if (pullRequest.ciState === "pending") {
      return {
        action: "wait_for_ci",
        title: "Continue from the current pull request",
        detail: "PR #" + pullRequest.pullRequest.number + " has CI in progress.",
      };
    }

    return {
      action: "review_pr",
      title: "Continue from the current pull request",
      detail:
        "PR #" +
        pullRequest.pullRequest.number +
        " is open with CI state " +
        pullRequest.ciState +
        ".",
    };
  }

  if (!git.clean) {
    return {
      action: "continue_changes",
      title: "Continue the current working-tree changes",
      detail:
        String(git.stagedCount + git.unstagedCount + git.untrackedCount) +
        " changed path(s) are present on branch " +
        (git.branch ?? "detached HEAD") +
        ".",
    };
  }

  if (task?.status.lifecycle === "in_progress") {
    return {
      action: "continue_task",
      title: "Continue the active task",
      detail: task.key + " — " + task.summary,
    };
  }

  if (nextTask) {
    return {
      action: "start_task",
      title: "Start the next unblocked task",
      detail: nextTask.key + " — " + nextTask.summary,
    };
  }

  if (repository.fileCount === 0) {
    return {
      action: "start_discovery",
      title: "Start project discovery",
      detail: "The workspace has no project files yet.",
    };
  }

  return {
    action: "ask_goal",
    title: "Ask what to work on next",
    detail:
      "The repository is mapped, but no active workflow, open PR, changed worktree, or recoverable task was found.",
  };
}

export async function recoverWorkspace(
  root: string,
  config: AgentConfig,
  store: WorkflowStateStore,
  options: RecoverWorkspaceOptions = {},
): Promise<WorkspaceRecovery> {
  const environment = options.environment ?? process.env;
  const warnings: string[] = [];

  const index = await loadOrBuildRepositoryIndex(
    root,
    config,
    options.rebuildIndex ?? false,
  );
  const repository = indexSummary(index);
  const constitution = await buildRepositoryConstitution(root, config, {
    rebuildIndex: false,
  });
  const git = await getGitStatus(root);
  const workflow = activeWorkflow(await store.loadCurrent());
  const taskSource = await detectTaskSources(root, environment);
  const pullRequest = await recoverPullRequest(root);

  let task: TaskRecord | undefined;
  let nextTask: TaskRecord | undefined;
  let taskCandidates: TaskRecord[] = [];

  if (workflow) {
    task = await recoverWorkflowTask(root, config, store, workflow, environment);
    if (!task) {
      warnings.push("Active workflow task metadata could not be refreshed from its provider.");
    }
  } else {
    task = await recoverBranchTask(
      root,
      config,
      taskSource,
      git.branch,
      environment,
    );

    if (!task) {
      const providerTasks = await recoverProviderTasks(
        root,
        config,
        taskSource,
        environment,
      );
      task = providerTasks.task;
      nextTask = providerTasks.nextTask;
      taskCandidates = providerTasks.candidates;
    }
  }

  const recommendation = recommendWorkspaceAction({
    repository,
    git,
    workflow,
    task,
    nextTask,
    pullRequest,
  });

  return {
    root,
    repository,
    git,
    workflow,
    taskSource,
    task,
    nextTask,
    taskCandidates,
    constitution,
    pullRequest,
    warnings,
    recommendation,
  };
}

export function workspaceRecoveryContext(recovery: WorkspaceRecovery): string {
  const lines = [
    "Recovered workspace context:",
    "- Repository map: " +
      recovery.repository.fileCount +
      " files, " +
      recovery.repository.symbolCount +
      " symbols, " +
      recovery.repository.importCount +
      " imports",
    "- Branch: " + (recovery.git.branch ?? "detached HEAD"),
    "- Working tree: " +
      (recovery.git.clean
        ? "clean"
        : recovery.git.stagedCount +
          " staged, " +
          recovery.git.unstagedCount +
          " unstaged, " +
          recovery.git.untrackedCount +
          " untracked"),
    "- Task source: " + recovery.taskSource.selected,
    recovery.workflow
      ? "- Workflow: " + recovery.workflow.taskRef + " / " + recovery.workflow.state
      : "- Workflow: none",
    recovery.task
      ? "- Active/recovered task: " +
        recovery.task.key +
        " — " +
        recovery.task.summary +
        " [" +
        recovery.task.status.name +
        "]"
      : "- Active/recovered task: none",
    recovery.nextTask
      ? "- Next task: " + recovery.nextTask.key + " — " + recovery.nextTask.summary
      : undefined,
    "- Constitution: " +
      recovery.constitution.counts.explicitRule +
      " explicit rules, " +
      recovery.constitution.counts.approvedRule +
      " approved rules, " +
      recovery.constitution.counts.inferredConvention +
      " inferred conventions, " +
      recovery.constitution.counts.proposedRule +
      " proposed rules",
    recovery.taskCandidates.length > 0
      ? "- Task candidates: " +
        recovery.taskCandidates
          .map(
            (task) =>
              task.key +
              " [" +
              task.status.name +
              "] " +
              task.summary +
              (task.dependencies.length > 0
                ? " (depends on " + task.dependencies.join(", ") + ")"
                : ""),
          )
          .join(" | ")
      : "- Task candidates: none",
    recovery.pullRequest
      ? "- Open PR: #" +
        recovery.pullRequest.pullRequest.number +
        " / CI " +
        recovery.pullRequest.ciState
      : "- Open PR: none",
    "- Recommended next action: " +
      recovery.recommendation.title +
      " — " +
      recovery.recommendation.detail,
  ].filter((line): line is string => Boolean(line));

  return lines.join("\n") + "\n\n" + repositoryConstitutionContext(recovery.constitution, {
    includeInferred: true,
    includeProposed: false,
    maxRules: 60,
  });
}
