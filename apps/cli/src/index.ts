#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Command } from "commander";
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
  .action(
    async (options: { pr?: string; method: string; root: string; approve?: boolean }) => {
      const root = resolve(options.root);
      const config = await loadAgentConfig(root);
      const store = new WorkflowStateStore(root, config);
      const result = await mergeWorkflowPullRequest(root, config, store, options.pr, {
        approved: options.approve ?? false,
        method: options.method,
      });

      console.log("Merged PR #" + result.merge.pullRequest.number + ".");
      console.log("State: " + result.workflow.state);
    },
  );

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
