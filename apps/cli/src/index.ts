#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Command } from "commander";
import {
  createJiraTaskProviderFromEnvironment,
  selectJiraWorkflowTask,
  syncJiraWorkflowTask,
  validateJiraWorkflowTask,
} from "@llmatic/jira-adapter";
import {
  selectWorkflowTask,
  syncWorkflowTask,
  validateWorkflowTask,
  type TaskRecord,
  type TaskTransition,
} from "@llmatic/task-provider";
import {
  detectTaskSources,
  resolveTaskProvider,
  resolveWorkflowTaskProvider,
  type TaskProviderId,
} from "@llmatic/task-router";
import {
  inspectRuntimeTools,
  parseRuntimeToolOperation,
  runRuntimeToolOperation,
  type RuntimeToolInspection,
  type RuntimeToolOperationResult,
} from "@llmatic/runtime-tools";
import {
  createPullRequest,
  createWorkflowPullRequest,
  getPullRequestStatus,
  mergePullRequest,
  mergeWorkflowPullRequest,
  refreshWorkflowRemoteCi,
  type PullRequestStatus,
} from "@llmatic/github-adapter";
import {
  analyzeWorkflowRepository,
  buildRepositoryIndex,
  loadRepositoryIndex,
  searchRepositoryIndex,
  type RepositoryIndex,
  type RepositorySearchHit,
} from "@llmatic/repo-intelligence";
import {
  commitStagedChanges,
  createBranch,
  createWorkflowBranch,
  getGitStatus,
  pushCurrentBranch,
  pushWorkflowBranch,
  stagePaths,
  type GitStatus,
} from "@llmatic/git-adapter";
import {
  DEFAULT_TOOL_REGISTRY,
  detectRegisteredTools,
  installRegisteredTool,
  parseToolId,
  type ToolDetection,
} from "@llmatic/tool-registry";
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
  runLocalValidation,
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

function printRuntimeInspection(item: RuntimeToolInspection): void {
  const marker = item.available ? "✓" : "·";
  const version = item.version ? " " + item.version : "";
  const executable = item.executable ? " [" + item.executable + "]" : "";
  console.log(marker + " " + item.pack + version + executable);
}

function printRuntimeResult(result: RuntimeToolOperationResult): void {
  console.log((result.success ? "PASS" : "FAIL") + ": " + result.pack + " " + result.operation);
  console.log("Command: " + result.command);
  if (result.stdout) console.log(result.stdout);
  if (result.stderr) console.error(result.stderr);
}

function printTask(task: TaskRecord): void {
  console.log(task.key + " — " + task.summary);
  console.log("Status: " + task.status.name);
  if (task.issueType) console.log("Type: " + task.issueType);
  if (task.priority) console.log("Priority: " + task.priority);
  if (task.assignee) console.log("Assignee: " + task.assignee);
  if (task.webUrl) console.log("URL: " + task.webUrl);
}

function printTaskTransition(transition: TaskTransition): void {
  const target = transition.toStatus ? " -> " + transition.toStatus : "";
  console.log(transition.id + " " + transition.name + target);
}

function printPullRequestStatus(status: PullRequestStatus): void {
  console.log("PR: #" + status.pullRequest.number + " " + status.pullRequest.url);
  console.log("State: " + status.pullRequest.state);
  console.log("Draft: " + (status.pullRequest.isDraft ? "yes" : "no"));
  console.log("Mergeable: " + status.pullRequest.mergeable);
  console.log("Merge state: " + status.pullRequest.mergeStateStatus);
  console.log("CI: " + status.ciState);
  console.log("Checks: " + status.checks.length);
}

function printRepositoryIndex(index: RepositoryIndex): void {
  console.log("Files: " + index.fileCount);
  console.log("Source files: " + index.sourceFileCount);
  console.log("Symbols: " + index.symbols.length);
  console.log("Imports: " + index.imports.length);
  console.log("Generated: " + index.generatedAt);
}

function printSearchHit(hit: RepositorySearchHit): void {
  const suffix = hit.line ? ":" + hit.line : "";
  console.log(hit.kind + " " + hit.path + suffix + " — " + hit.label);
}

function printGitStatus(status: GitStatus): void {
  console.log("Branch: " + (status.branch ?? "(detached)"));
  console.log("Clean: " + (status.clean ? "yes" : "no"));
  console.log("Staged: " + status.stagedCount);
  console.log("Unstaged: " + status.unstagedCount);
  console.log("Untracked: " + status.untrackedCount);
}

function printToolStatus(status: ToolDetection): void {
  const marker = status.installed ? "✓" : "·";
  const version = status.version ? " " + status.version : "";
  const installer = status.installerAvailable ? " [auto-install]" : "";

  console.log(marker + " " + status.name + version + installer);
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

async function runValidation(rootInput: string, approved: boolean): Promise<void> {
  const root = resolve(rootInput);
  const config = await loadAgentConfig(root);
  const store = new WorkflowStateStore(root, config);
  const report = await runLocalValidation(root, config, store, { approved });

  console.log("");
  console.log("Validation: " + (report.success ? "PASS" : "FAIL"));
  console.log("State: " + report.finishedState);
  console.log("Gates:");

  for (const result of report.results) {
    console.log(
      "  " +
        (result.success ? "✓" : "✗") +
        " " +
        result.capability +
        " (" +
        result.durationMs +
        "ms)",
    );
  }

  if (!report.success) {
    const failed = report.results.find((result) => !result.success);
    process.exitCode = failed?.exitCode || 1;
  }
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
  .argument(
    "<capability>",
    "Capability: " + ["format", "lint", "typecheck", "test", "build", "ci"].join(", "),
  )
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

const taskCommand = program
  .command("task")
  .description("Read and update tasks through the detected or selected task provider.");

taskCommand
  .command("detect")
  .description("Detect available task sources and show which provider auto mode selects.")
  .option("-r, --root <path>", "Repository root", process.cwd())
  .option("--json", "Print machine-readable JSON")
  .action(async (options: { root: string; json?: boolean }) => {
    const detection = await detectTaskSources(resolve(options.root));

    if (options.json) {
      console.log(JSON.stringify(detection, null, 2));
      return;
    }

    console.log("Selected: " + detection.selected);
    for (const candidate of detection.candidates) {
      console.log(
        (candidate.available ? "✓" : "·") + " " + candidate.id + " — " + candidate.detail,
      );
    }
  });

taskCommand
  .command("list")
  .description("List tasks from a provider that supports enumeration.")
  .option("-r, --root <path>", "Repository root", process.cwd())
  .option("--provider <provider>", "Provider: auto, markdown, jira, github, or manual", "auto")
  .option("--approve", "Approve when taskRead is configured as 'ask'")
  .option("--json", "Print machine-readable JSON")
  .action(
    async (options: {
      root: string;
      provider: TaskProviderId;
      approve?: boolean;
      json?: boolean;
    }) => {
      const root = resolve(options.root);
      const config = await loadAgentConfig(root);
      const provider = await resolveTaskProvider(root, config, options.provider);

      if (!provider.listTasks) {
        throw new Error("Task provider " + provider.id + " does not support task listing.");
      }

      const tasks = await provider.listTasks({ approved: options.approve ?? false });

      if (options.json) {
        console.log(JSON.stringify(tasks, null, 2));
        return;
      }

      for (const task of tasks) {
        printTask(task);
        console.log("");
      }
    },
  );

taskCommand
  .command("next")
  .description(
    "Return the next unblocked task when the provider supports dependency-aware selection.",
  )
  .option("-r, --root <path>", "Repository root", process.cwd())
  .option("--provider <provider>", "Provider: auto, markdown, jira, github, or manual", "auto")
  .option("--approve", "Approve when taskRead is configured as 'ask'")
  .option("--json", "Print machine-readable JSON")
  .action(
    async (options: {
      root: string;
      provider: TaskProviderId;
      approve?: boolean;
      json?: boolean;
    }) => {
      const root = resolve(options.root);
      const config = await loadAgentConfig(root);
      const provider = await resolveTaskProvider(root, config, options.provider);

      if (!provider.getNextTask) {
        throw new Error("Task provider " + provider.id + " does not support next-task selection.");
      }

      const task = await provider.getNextTask({ approved: options.approve ?? false });

      if (options.json) {
        console.log(JSON.stringify(task ?? null, null, 2));
        return;
      }

      if (!task) {
        console.log("No unblocked todo task is available.");
        return;
      }

      printTask(task);
    },
  );

taskCommand
  .command("get")
  .description("Read one task through the selected provider.")
  .argument("<reference>", "Task key/reference")
  .option("-r, --root <path>", "Repository root", process.cwd())
  .option("--provider <provider>", "Provider: auto, markdown, jira, github, or manual", "auto")
  .option("--approve", "Approve when taskRead is configured as 'ask'")
  .option("--json", "Print machine-readable JSON")
  .action(
    async (
      reference: string,
      options: {
        root: string;
        provider: TaskProviderId;
        approve?: boolean;
        json?: boolean;
      },
    ) => {
      const root = resolve(options.root);
      const config = await loadAgentConfig(root);
      const provider = await resolveTaskProvider(root, config, options.provider);
      const task = await provider.getTask(reference, {
        approved: options.approve ?? false,
      });

      if (options.json) {
        console.log(JSON.stringify(task, null, 2));
        return;
      }

      printTask(task);
    },
  );

taskCommand
  .command("start")
  .description("Select a provider task and start the persistent workflow in TASK_SELECTED.")
  .argument("<reference>", "Task key/reference")
  .option("-r, --root <path>", "Repository root", process.cwd())
  .option("--provider <provider>", "Provider: auto, markdown, jira, github, or manual", "auto")
  .option("--approve", "Approve when taskRead is configured as 'ask'")
  .action(
    async (
      reference: string,
      options: { root: string; provider: TaskProviderId; approve?: boolean },
    ) => {
      const root = resolve(options.root);
      const config = await loadAgentConfig(root);
      const store = new WorkflowStateStore(root, config);
      const provider = await resolveTaskProvider(root, config, options.provider);
      const result = await selectWorkflowTask(store, provider, reference, {
        approved: options.approve ?? false,
      });

      printTask(result.task);
      console.log("");
      printWorkflow(result.workflow);
    },
  );

taskCommand
  .command("validate")
  .description(
    "Refresh the workflow task through its original provider and advance to TASK_VALIDATED.",
  )
  .option("-r, --root <path>", "Repository root", process.cwd())
  .option(
    "--provider <provider>",
    "Override provider; default preserves the workflow provider",
    "auto",
  )
  .option("--approve", "Approve when taskRead is configured as 'ask'")
  .action(async (options: { root: string; provider: TaskProviderId; approve?: boolean }) => {
    const root = resolve(options.root);
    const config = await loadAgentConfig(root);
    const store = new WorkflowStateStore(root, config);
    const provider = await resolveWorkflowTaskProvider(root, config, store, options.provider);
    const result = await validateWorkflowTask(store, provider, {
      approved: options.approve ?? false,
    });

    printTask(result.task);
    console.log("");
    printWorkflow(result.workflow);
  });

taskCommand
  .command("comment")
  .description("Add a provider-native note/comment to a task.")
  .argument("<reference>", "Task key/reference")
  .requiredOption("--text <text>", "Comment/note text")
  .option("-r, --root <path>", "Repository root", process.cwd())
  .option("--provider <provider>", "Provider: auto, markdown, jira, github, or manual", "auto")
  .option("--approve", "Approve when taskWrite is configured as 'ask'")
  .action(
    async (
      reference: string,
      options: {
        text: string;
        root: string;
        provider: TaskProviderId;
        approve?: boolean;
      },
    ) => {
      const root = resolve(options.root);
      const config = await loadAgentConfig(root);
      const provider = await resolveTaskProvider(root, config, options.provider);
      await provider.addComment(reference, options.text, {
        approved: options.approve ?? false,
      });
      console.log("Comment/note added to " + reference + " through " + provider.id + ".");
    },
  );

taskCommand
  .command("transition")
  .description("Apply a provider-native task transition.")
  .argument("<reference>", "Task key/reference")
  .requiredOption("--to <transition>", "Transition name or ID")
  .option("-r, --root <path>", "Repository root", process.cwd())
  .option("--provider <provider>", "Provider: auto, markdown, jira, github, or manual", "auto")
  .option("--approve", "Approve when taskWrite is configured as 'ask'")
  .action(
    async (
      reference: string,
      options: {
        to: string;
        root: string;
        provider: TaskProviderId;
        approve?: boolean;
      },
    ) => {
      const root = resolve(options.root);
      const config = await loadAgentConfig(root);
      const provider = await resolveTaskProvider(root, config, options.provider);
      const transition = await provider.transitionTask(reference, options.to, {
        approved: options.approve ?? false,
      });
      console.log(
        "Transitioned " + reference + " via " + transition.name + " through " + provider.id + ".",
      );
    },
  );

taskCommand
  .command("complete")
  .description(
    "Complete the active workflow task in its original provider, optionally adding evidence.",
  )
  .option("-r, --root <path>", "Repository root", process.cwd())
  .option(
    "--provider <provider>",
    "Override provider; default preserves the workflow provider",
    "auto",
  )
  .option("--evidence <text>", "Completion evidence/comment")
  .option("--approve", "Approve when taskWrite is configured as 'ask'")
  .action(
    async (options: {
      root: string;
      provider: TaskProviderId;
      evidence?: string;
      approve?: boolean;
    }) => {
      const root = resolve(options.root);
      const config = await loadAgentConfig(root);
      const store = new WorkflowStateStore(root, config);
      const provider = await resolveWorkflowTaskProvider(root, config, store, options.provider);
      const result = await syncWorkflowTask(store, provider, {
        comment: options.evidence,
        transition: "complete",
        approved: options.approve ?? false,
      });

      console.log(
        "Synced " +
          result.taskRef +
          " through " +
          provider.id +
          (result.transition ? " via " + result.transition.name : "") +
          ".",
      );
    },
  );

const jiraCommand = program.command("jira").description("Read and update Jira Cloud tasks.");

jiraCommand
  .command("get")
  .description("Read a Jira issue through taskRead permission.")
  .argument("<key>", "Jira issue key")
  .option("-r, --root <path>", "Repository root", process.cwd())
  .option("--approve", "Approve when taskRead is configured as 'ask'")
  .option("--json", "Print machine-readable JSON")
  .action(async (key: string, options: { root: string; approve?: boolean; json?: boolean }) => {
    const root = resolve(options.root);
    const config = await loadAgentConfig(root);
    const provider = createJiraTaskProviderFromEnvironment(config);
    const task = await provider.getTask(key, { approved: options.approve ?? false });

    if (options.json) {
      console.log(JSON.stringify(task, null, 2));
      return;
    }

    printTask(task);
  });

jiraCommand
  .command("transitions")
  .description("List Jira transitions available to the authenticated user.")
  .argument("<key>", "Jira issue key")
  .option("-r, --root <path>", "Repository root", process.cwd())
  .option("--approve", "Approve when taskRead is configured as 'ask'")
  .option("--json", "Print machine-readable JSON")
  .action(async (key: string, options: { root: string; approve?: boolean; json?: boolean }) => {
    const root = resolve(options.root);
    const config = await loadAgentConfig(root);
    const provider = createJiraTaskProviderFromEnvironment(config);
    const transitions = await provider.listTransitions(key, {
      approved: options.approve ?? false,
    });

    if (options.json) {
      console.log(JSON.stringify(transitions, null, 2));
      return;
    }

    for (const transition of transitions) printTaskTransition(transition);
  });

jiraCommand
  .command("comment")
  .description("Add a Jira comment through taskWrite permission.")
  .argument("<key>", "Jira issue key")
  .requiredOption("--text <text>", "Comment text")
  .option("-r, --root <path>", "Repository root", process.cwd())
  .option("--approve", "Approve when taskWrite is configured as 'ask'")
  .action(async (key: string, options: { text: string; root: string; approve?: boolean }) => {
    const root = resolve(options.root);
    const config = await loadAgentConfig(root);
    const provider = createJiraTaskProviderFromEnvironment(config);
    await provider.addComment(key, options.text, { approved: options.approve ?? false });
    console.log("Comment added to " + key + ".");
  });

jiraCommand
  .command("transition")
  .description("Transition a Jira issue by transition name or ID.")
  .argument("<key>", "Jira issue key")
  .requiredOption("--to <transition>", "Transition name or transition ID")
  .option("-r, --root <path>", "Repository root", process.cwd())
  .option("--approve", "Approve when taskWrite is configured as 'ask'")
  .action(async (key: string, options: { to: string; root: string; approve?: boolean }) => {
    const root = resolve(options.root);
    const config = await loadAgentConfig(root);
    const provider = createJiraTaskProviderFromEnvironment(config);
    const transition = await provider.transitionTask(key, options.to, {
      approved: options.approve ?? false,
    });
    console.log("Transitioned " + key + " via " + transition.name + ".");
  });

const githubCommand = program.command("github").description("Run protected GitHub operations.");
const githubPrCommand = githubCommand.command("pr").description("Work with GitHub pull requests.");

githubPrCommand
  .command("status")
  .description("Show pull-request metadata and CI checks.")
  .argument("[ref]", "Pull-request number, URL, or branch")
  .option("-r, --root <path>", "Repository root", process.cwd())
  .option("--json", "Print machine-readable JSON")
  .action(async (ref: string | undefined, options: { root: string; json?: boolean }) => {
    const status = await getPullRequestStatus(resolve(options.root), ref);

    if (options.json) {
      console.log(JSON.stringify(status, null, 2));
      return;
    }

    printPullRequestStatus(status);
  });

githubPrCommand
  .command("create")
  .description("Create a pull request through the createPullRequest permission gate.")
  .requiredOption("--title <title>", "Pull-request title")
  .option("--body <body>", "Pull-request body", "")
  .option("--base <branch>", "Base branch")
  .option("--head <branch>", "Head branch")
  .option("--draft", "Create a draft pull request")
  .option("-r, --root <path>", "Repository root", process.cwd())
  .option("--approve", "Approve when createPullRequest is configured as 'ask'")
  .action(
    async (options: {
      title: string;
      body: string;
      base?: string;
      head?: string;
      draft?: boolean;
      root: string;
      approve?: boolean;
    }) => {
      const root = resolve(options.root);
      const config = await loadAgentConfig(root);
      const pullRequest = await createPullRequest(
        root,
        config,
        {
          title: options.title,
          body: options.body,
          base: options.base,
          head: options.head,
          draft: options.draft ?? false,
        },
        { approved: options.approve ?? false },
      );

      console.log("Created PR #" + pullRequest.number + ": " + pullRequest.url);
    },
  );

githubPrCommand
  .command("merge")
  .description("Merge a pull request through the mergePullRequest permission gate.")
  .argument("[ref]", "Pull-request number, URL, or branch")
  .option("--method <method>", "Merge method: squash, merge, or rebase", "squash")
  .option("-r, --root <path>", "Repository root", process.cwd())
  .option("--approve", "Approve when mergePullRequest is configured as 'ask'")
  .action(
    async (
      ref: string | undefined,
      options: { method: string; root: string; approve?: boolean },
    ) => {
      const root = resolve(options.root);
      const config = await loadAgentConfig(root);
      const result = await mergePullRequest(root, config, ref, {
        approved: options.approve ?? false,
        method: options.method,
      });

      console.log("Merged PR #" + result.pullRequest.number + " using " + result.method + ".");
    },
  );

const repoCommand = program.command("repo").description("Build and query repository intelligence.");

repoCommand
  .command("index")
  .description("Build the repository file/symbol/import index.")
  .option("-r, --root <path>", "Repository root", process.cwd())
  .option("--approve", "Approve when repositoryRead is configured as 'ask'")
  .option("--json", "Print machine-readable JSON")
  .action(async (options: { root: string; approve?: boolean; json?: boolean }) => {
    const root = resolve(options.root);
    const config = await loadAgentConfig(root);
    const index = await buildRepositoryIndex(root, config, {
      approved: options.approve ?? false,
    });

    if (options.json) {
      console.log(JSON.stringify(index, null, 2));
      return;
    }

    printRepositoryIndex(index);
  });

repoCommand
  .command("search")
  .description("Search the cached repository index.")
  .argument("<query>", "Symbol, path, or import query")
  .option("-r, --root <path>", "Repository root", process.cwd())
  .option("-n, --limit <count>", "Maximum results", "20")
  .option("--json", "Print machine-readable JSON")
  .action(async (query: string, options: { root: string; limit: string; json?: boolean }) => {
    const root = resolve(options.root);
    const config = await loadAgentConfig(root);
    const index = await loadRepositoryIndex(root, config);
    const limit = Number.parseInt(options.limit, 10);

    if (!Number.isInteger(limit) || limit <= 0) {
      throw new Error("Search limit must be a positive integer.");
    }

    const hits = searchRepositoryIndex(index, query, limit);

    if (options.json) {
      console.log(JSON.stringify(hits, null, 2));
      return;
    }

    for (const hit of hits) {
      printSearchHit(hit);
    }
  });

const gitCommand = program.command("git").description("Run protected Git operations.");

gitCommand
  .command("status")
  .description("Show repository Git status.")
  .option("-r, --root <path>", "Repository root", process.cwd())
  .option("--json", "Print machine-readable JSON")
  .action(async (options: { root: string; json?: boolean }) => {
    const status = await getGitStatus(resolve(options.root));

    if (options.json) {
      console.log(JSON.stringify(status, null, 2));
      return;
    }

    printGitStatus(status);
  });

gitCommand
  .command("branch")
  .description("Create a branch through the repositoryWrite permission gate.")
  .argument("<name>", "Branch name")
  .option("-r, --root <path>", "Repository root", process.cwd())
  .option("--approve", "Approve when repositoryWrite is configured as 'ask'")
  .action(async (name: string, options: { root: string; approve?: boolean }) => {
    const root = resolve(options.root);
    const config = await loadAgentConfig(root);
    const result = await createBranch(root, config, name, {
      approved: options.approve ?? false,
    });

    console.log("Created branch: " + result.branch);
  });

gitCommand
  .command("stage")
  .description("Stage explicit repository paths.")
  .argument("<paths...>", "Paths to stage")
  .option("-r, --root <path>", "Repository root", process.cwd())
  .option("--approve", "Approve when repositoryWrite is configured as 'ask'")
  .action(async (paths: string[], options: { root: string; approve?: boolean }) => {
    const root = resolve(options.root);
    const config = await loadAgentConfig(root);
    await stagePaths(root, config, paths, {
      approved: options.approve ?? false,
    });

    console.log("Staged paths: " + paths.join(", "));
  });

gitCommand
  .command("commit")
  .description("Commit already staged changes.")
  .requiredOption("-m, --message <message>", "Commit message")
  .option("-r, --root <path>", "Repository root", process.cwd())
  .option("--approve", "Approve when repositoryWrite is configured as 'ask'")
  .action(async (options: { message: string; root: string; approve?: boolean }) => {
    const root = resolve(options.root);
    const config = await loadAgentConfig(root);
    const result = await commitStagedChanges(root, config, options.message, {
      approved: options.approve ?? false,
    });

    console.log("Commit: " + result.commitSha);
  });

gitCommand
  .command("push")
  .description("Push the current branch through the gitPush permission gate.")
  .option("-r, --root <path>", "Repository root", process.cwd())
  .option("--remote <remote>", "Git remote", "origin")
  .option("--set-upstream", "Set upstream for the current branch")
  .option("--approve", "Approve when gitPush is configured as 'ask'")
  .action(
    async (options: { root: string; remote: string; setUpstream?: boolean; approve?: boolean }) => {
      const root = resolve(options.root);
      const config = await loadAgentConfig(root);
      const result = await pushCurrentBranch(root, config, {
        remote: options.remote,
        setUpstream: options.setUpstream ?? false,
        approved: options.approve ?? false,
      });

      console.log("Pushed " + result.branch + " to " + result.remote + ".");
    },
  );

const runtimeCommand = program
  .command("runtime")
  .description("Inspect and run whitelisted local runtime tool-pack operations.");

runtimeCommand
  .command("inspect")
  .description("Inspect Docker, Supabase, Python, and Ollama runtime availability.")
  .option("-r, --root <path>", "Repository root", process.cwd())
  .option("--json", "Print machine-readable JSON")
  .action(async (options: { root: string; json?: boolean }) => {
    const result = await inspectRuntimeTools(resolve(options.root));

    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    for (const item of result) printRuntimeInspection(item);
  });

runtimeCommand
  .command("run")
  .description("Run a whitelisted runtime tool-pack operation.")
  .argument("<pack>", "Pack: docker, supabase, python, ollama")
  .argument("<operation>", "Pack operation")
  .option("-r, --root <path>", "Repository root", process.cwd())
  .option("--script <path>", "Repository-relative Python script")
  .option("--model <name>", "Ollama model name")
  .option("--prompt <text>", "Ollama prompt")
  .option("--arg <value...>", "Arguments passed to a Python script")
  .option("--approve", "Approve an ask-gated local operation")
  .option("--json", "Print machine-readable JSON")
  .action(
    async (
      pack: string,
      operation: string,
      options: {
        root: string;
        script?: string;
        model?: string;
        prompt?: string;
        arg?: string[];
        approve?: boolean;
        json?: boolean;
      },
    ) => {
      const root = resolve(options.root);
      const config = await loadAgentConfig(root);
      const store = new WorkflowStateStore(root, config);
      const request = parseRuntimeToolOperation(pack, operation, {
        script: options.script,
        model: options.model,
        prompt: options.prompt,
        args: options.arg ?? [],
      });
      const result = await runRuntimeToolOperation(root, config, store, request, {
        approved: options.approve ?? false,
      });

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        printRuntimeResult(result);
      }

      if (!result.success) process.exitCode = result.exitCode || 1;
    },
  );

const toolsCommand = program.command("tools").description("Inspect and manage registered tools.");

toolsCommand
  .command("list")
  .description("Detect tools known to the runtime.")
  .option("-r, --root <path>", "Repository root", process.cwd())
  .option("--json", "Print machine-readable JSON")
  .action(async (options: { root: string; json?: boolean }) => {
    const statuses = await detectRegisteredTools(resolve(options.root), DEFAULT_TOOL_REGISTRY);

    if (options.json) {
      console.log(JSON.stringify(statuses, null, 2));
      return;
    }

    console.log("Registered tools:");
    for (const status of statuses) {
      printToolStatus(status);
    }
  });

toolsCommand
  .command("install")
  .description("Install a registered tool through its controlled installer.")
  .argument("<tool>", "Registered tool id")
  .option("-r, --root <path>", "Repository root", process.cwd())
  .option("--approve", "Approve installation when installTools is configured as 'ask'")
  .action(async (toolInput: string, options: { root: string; approve?: boolean }) => {
    const root = resolve(options.root);
    const config = await loadAgentConfig(root);
    const toolId = parseToolId(toolInput);
    const result = await installRegisteredTool(root, config, toolId, {
      approved: options.approve ?? false,
    });

    console.log(result.changed ? "Tool installation completed." : "Tool already available.");
    printToolStatus(result.tool);
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
  .command("select-jira")
  .description("Select a Jira task and start a workflow in TASK_SELECTED.")
  .argument("<key>", "Jira issue key")
  .option("-r, --root <path>", "Repository root", process.cwd())
  .option("--approve", "Approve when taskRead is configured as 'ask'")
  .action(async (key: string, options: { root: string; approve?: boolean }) => {
    const root = resolve(options.root);
    const config = await loadAgentConfig(root);
    const store = new WorkflowStateStore(root, config);
    const provider = createJiraTaskProviderFromEnvironment(config);
    const result = await selectJiraWorkflowTask(store, provider, key, {
      approved: options.approve ?? false,
    });

    printTask(result.task);
    console.log("State: " + result.workflow.state);
  });

workflow
  .command("validate-jira")
  .description("Refresh and validate the selected Jira task, then advance to TASK_VALIDATED.")
  .option("-r, --root <path>", "Repository root", process.cwd())
  .option("--approve", "Approve when taskRead is configured as 'ask'")
  .action(async (options: { root: string; approve?: boolean }) => {
    const root = resolve(options.root);
    const config = await loadAgentConfig(root);
    const store = new WorkflowStateStore(root, config);
    const provider = createJiraTaskProviderFromEnvironment(config);
    const result = await validateJiraWorkflowTask(store, provider, {
      approved: options.approve ?? false,
    });

    printTask(result.task);
    console.log("State: " + result.workflow.state);
  });

workflow
  .command("sync-jira")
  .description(
    "Synchronize workflow evidence back to the Jira task without changing workflow state.",
  )
  .option("--comment <text>", "Comment to add")
  .option("--transition <transition>", "Transition name or ID")
  .option("-r, --root <path>", "Repository root", process.cwd())
  .option("--approve", "Approve when taskWrite is configured as 'ask'")
  .action(
    async (options: { comment?: string; transition?: string; root: string; approve?: boolean }) => {
      const root = resolve(options.root);
      const config = await loadAgentConfig(root);
      const store = new WorkflowStateStore(root, config);
      const provider = createJiraTaskProviderFromEnvironment(config);
      const result = await syncJiraWorkflowTask(store, provider, {
        comment: options.comment,
        transition: options.transition,
        approved: options.approve ?? false,
      });

      console.log("Synchronized Jira task " + result.taskRef + ".");
      if (result.transition) console.log("Transition: " + result.transition.name);
    },
  );

workflow
  .command("analyze")
  .description("Build repository intelligence and advance TASK_VALIDATED -> REPO_ANALYZED.")
  .option("-r, --root <path>", "Repository root", process.cwd())
  .option("--approve", "Approve when repositoryRead is configured as 'ask'")
  .action(async (options: { root: string; approve?: boolean }) => {
    const root = resolve(options.root);
    const config = await loadAgentConfig(root);
    const store = new WorkflowStateStore(root, config);
    const result = await analyzeWorkflowRepository(root, config, store, {
      approved: options.approve ?? false,
    });

    printRepositoryIndex(result.index);
    console.log("State: " + result.workflow.state);
  });

workflow
  .command("branch")
  .description("Create the workflow branch and advance REPO_ANALYZED -> BRANCH_CREATED.")
  .argument("<name>", "Branch name")
  .option("-r, --root <path>", "Repository root", process.cwd())
  .option("--approve", "Approve when repositoryWrite is configured as 'ask'")
  .action(async (name: string, options: { root: string; approve?: boolean }) => {
    const root = resolve(options.root);
    const config = await loadAgentConfig(root);
    const store = new WorkflowStateStore(root, config);
    const result = await createWorkflowBranch(root, config, store, name, {
      approved: options.approve ?? false,
    });

    console.log("Created branch: " + result.branch);
    console.log("State: " + result.workflow.state);
  });

workflow
  .command("push")
  .description("Push the workflow branch and advance READY_TO_PUSH -> PUSHED.")
  .option("-r, --root <path>", "Repository root", process.cwd())
  .option("--remote <remote>", "Git remote", "origin")
  .option("--set-upstream", "Set upstream for the current branch")
  .option("--approve", "Approve when gitPush is configured as 'ask'")
  .action(
    async (options: { root: string; remote: string; setUpstream?: boolean; approve?: boolean }) => {
      const root = resolve(options.root);
      const config = await loadAgentConfig(root);
      const store = new WorkflowStateStore(root, config);
      const result = await pushWorkflowBranch(root, config, store, {
        remote: options.remote,
        setUpstream: options.setUpstream ?? false,
        approved: options.approve ?? false,
      });

      console.log("Pushed " + result.push.branch + " to " + result.push.remote + ".");
      console.log("State: " + result.workflow.state);
    },
  );

workflow
  .command("open-pr")
  .description("Create the workflow pull request and advance PUSHED -> PR_OPEN.")
  .requiredOption("--title <title>", "Pull-request title")
  .option("--body <body>", "Pull-request body", "")
  .option("--base <branch>", "Base branch")
  .option("--head <branch>", "Head branch")
  .option("--draft", "Create a draft pull request")
  .option("-r, --root <path>", "Repository root", process.cwd())
  .option("--approve", "Approve when createPullRequest is configured as 'ask'")
  .action(
    async (options: {
      title: string;
      body: string;
      base?: string;
      head?: string;
      draft?: boolean;
      root: string;
      approve?: boolean;
    }) => {
      const root = resolve(options.root);
      const config = await loadAgentConfig(root);
      const store = new WorkflowStateStore(root, config);
      const result = await createWorkflowPullRequest(
        root,
        config,
        store,
        {
          title: options.title,
          body: options.body,
          base: options.base,
          head: options.head,
          draft: options.draft ?? false,
        },
        { approved: options.approve ?? false },
      );

      console.log("Created PR #" + result.pullRequest.number + ": " + result.pullRequest.url);
      console.log("State: " + result.workflow.state);
    },
  );

workflow
  .command("remote-ci")
  .description("Refresh GitHub PR checks and advance workflow state from the result.")
  .option("--pr <ref>", "Pull-request number, URL, or branch")
  .option("-r, --root <path>", "Repository root", process.cwd())
  .action(async (options: { pr?: string; root: string }) => {
    const root = resolve(options.root);
    const config = await loadAgentConfig(root);
    const store = new WorkflowStateStore(root, config);
    const result = await refreshWorkflowRemoteCi(root, store, options.pr);

    printPullRequestStatus(result.status);
    console.log("State: " + result.workflow.state);
  });

workflow
  .command("merge")
  .description("Merge the workflow pull request and advance READY_TO_MERGE -> COMPLETED.")
  .option("--pr <ref>", "Pull-request number, URL, or branch")
  .option("--method <method>", "Merge method: squash, merge, or rebase", "squash")
  .option("-r, --root <path>", "Repository root", process.cwd())
  .option("--approve", "Approve when mergePullRequest is configured as 'ask'")
  .action(async (options: { pr?: string; method: string; root: string; approve?: boolean }) => {
    const root = resolve(options.root);
    const config = await loadAgentConfig(root);
    const store = new WorkflowStateStore(root, config);
    const result = await mergeWorkflowPullRequest(root, config, store, options.pr, {
      approved: options.approve ?? false,
      method: options.method,
    });

    console.log("Merged PR #" + result.merge.pullRequest.number + ".");
    console.log("State: " + result.workflow.state);
  });

workflow
  .command("validate")
  .description("Run required local gates and advance workflow state automatically.")
  .option("-r, --root <path>", "Repository root", process.cwd())
  .option("--approve", "Approve capabilities configured with permission 'ask'")
  .action(async (options: { root: string; approve?: boolean }) => {
    await runValidation(options.root, options.approve ?? false);
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
  .command("validate")
  .description("Alias for workflow validate.")
  .option("-r, --root <path>", "Repository root", process.cwd())
  .option("--approve", "Approve capabilities configured with permission 'ask'")
  .action(async (options: { root: string; approve?: boolean }) => {
    await runValidation(options.root, options.approve ?? false);
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
