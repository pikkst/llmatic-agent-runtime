import { resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/server";
import {
  createJiraTaskProviderFromEnvironment,
  selectJiraWorkflowTask,
  syncJiraWorkflowTask,
  validateJiraWorkflowTask,
} from "@llmatic/jira-adapter";
import { selectWorkflowTask, syncWorkflowTask, validateWorkflowTask } from "@llmatic/task-provider";
import { loadDiscoverySession } from "@llmatic/discovery-engine";
import {
  generateProjectPlan,
  loadCurrentProjectPlan,
  loadProjectPlanManifest,
  readProjectPlanArtifact,
} from "@llmatic/planning-engine";
import {
  detectTaskSources,
  resolveTaskProvider,
  resolveWorkflowTaskProvider,
} from "@llmatic/task-router";
import * as z from "zod/v4";
import {
  inspectRuntimeTools,
  parseRuntimeToolOperation,
  runRuntimeToolOperation,
} from "@llmatic/runtime-tools";
import {
  WorkflowStateStore,
  detectRepository,
  executeCapability,
  loadAgentConfig,
  managedWorkspaceDirectory,
  normalizeWorkflowState,
  recordCapabilityCheckpoint,
  runLocalValidation,
  startWorkflow,
  transitionWorkflow,
  type CapabilityName,
} from "@llmatic/core";
import {
  commitStagedChanges,
  createWorkflowBranch,
  getGitStatus,
  pushWorkflowBranch,
  stagePaths,
} from "@llmatic/git-adapter";
import {
  createWorkflowPullRequest,
  getPullRequestStatus,
  mergeWorkflowPullRequest,
  refreshWorkflowRemoteCi,
} from "@llmatic/github-adapter";
import {
  analyzeWorkflowRepository,
  loadRepositoryIndex,
  searchRepositoryIndex,
} from "@llmatic/repo-intelligence";
import { DEFAULT_TOOL_REGISTRY, detectRegisteredTools } from "@llmatic/tool-registry";

const capabilitySchema = z.enum(["format", "lint", "typecheck", "test", "build", "ci"]);
const workflowStateInputSchema = z.string().min(1);

function runtimeRoot(root?: string): string {
  return resolve(root ?? process.env.LLMATIC_ROOT ?? process.cwd());
}

function planningWorkspaceDirectory(root: string): string {
  const llmaticHome = process.env.LLMATIC_HOME?.trim();
  if (!llmaticHome) {
    throw new Error(
      "LLMATIC_HOME is required for private discovery/planning MCP tools.",
    );
  }

  return managedWorkspaceDirectory(root, llmaticHome);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function toolResult<T>(operation: () => Promise<T> | T) {
  try {
    const value = await operation();
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(value, null, 2),
        },
      ],
    };
  } catch (error) {
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: errorMessage(error),
        },
      ],
    };
  }
}

async function runtimeContext(rootInput?: string) {
  const root = runtimeRoot(rootInput);
  const config = await loadAgentConfig(root);
  const store = new WorkflowStateStore(root, config);
  return { root, config, store };
}

export function createLlmaticMcpServer(): McpServer {
  const server = new McpServer({
    name: "llmatic-agent-runtime",
    version: "0.1.0",
  });

  const taskProviderSchema = z.enum(["auto", "markdown", "jira", "github", "manual"]);

  server.registerTool(
    "llmatic_task_detect",
    {
      description:
        "Detect available task sources. Auto mode prefers local Markdown tasks, then Jira, then manual references.",
      inputSchema: z.object({
        root: z.string().optional(),
      }),
    },
    async ({ root }) => toolResult(() => detectTaskSources(runtimeRoot(root))),
  );

  server.registerTool(
    "llmatic_task_list",
    {
      description:
        "List tasks from the detected/selected provider when that provider supports enumeration.",
      inputSchema: z.object({
        root: z.string().optional(),
        provider: taskProviderSchema.optional(),
      }),
    },
    async ({ root, provider }) =>
      toolResult(async () => {
        const context = await runtimeContext(root);
        const selected = await resolveTaskProvider(
          context.root,
          context.config,
          provider ?? "auto",
        );

        if (!selected.listTasks) {
          throw new Error("Task provider " + selected.id + " does not support task listing.");
        }

        return selected.listTasks();
      }),
  );

  server.registerTool(
    "llmatic_task_next",
    {
      description:
        "Return the next dependency-unblocked task when the selected provider supports next-task selection.",
      inputSchema: z.object({
        root: z.string().optional(),
        provider: taskProviderSchema.optional(),
      }),
    },
    async ({ root, provider }) =>
      toolResult(async () => {
        const context = await runtimeContext(root);
        const selected = await resolveTaskProvider(
          context.root,
          context.config,
          provider ?? "auto",
        );

        if (!selected.getNextTask) {
          throw new Error(
            "Task provider " + selected.id + " does not support next-task selection.",
          );
        }

        return (await selected.getNextTask()) ?? null;
      }),
  );

  server.registerTool(
    "llmatic_task_get",
    {
      description: "Read one task through the detected/selected task provider.",
      inputSchema: z.object({
        root: z.string().optional(),
        provider: taskProviderSchema.optional(),
        reference: z.string().min(1),
      }),
    },
    async ({ root, provider, reference }) =>
      toolResult(async () => {
        const context = await runtimeContext(root);
        const selected = await resolveTaskProvider(
          context.root,
          context.config,
          provider ?? "auto",
        );
        return selected.getTask(reference);
      }),
  );

  server.registerTool(
    "llmatic_workflow_select_task",
    {
      description:
        "Read a provider-neutral task and start a workflow in TASK_SELECTED. MCP never self-approves taskRead=ask.",
      inputSchema: z.object({
        root: z.string().optional(),
        provider: taskProviderSchema.optional(),
        reference: z.string().min(1),
      }),
    },
    async ({ root, provider, reference }) =>
      toolResult(async () => {
        const context = await runtimeContext(root);
        const selected = await resolveTaskProvider(
          context.root,
          context.config,
          provider ?? "auto",
        );
        return selectWorkflowTask(context.store, selected, reference);
      }),
  );

  server.registerTool(
    "llmatic_workflow_validate_task",
    {
      description:
        "Refresh the selected task through the workflow's original provider and advance TASK_SELECTED to TASK_VALIDATED.",
      inputSchema: z.object({
        root: z.string().optional(),
        provider: taskProviderSchema.optional(),
      }),
    },
    async ({ root, provider }) =>
      toolResult(async () => {
        const context = await runtimeContext(root);
        const selected = await resolveWorkflowTaskProvider(
          context.root,
          context.config,
          context.store,
          provider ?? "auto",
        );
        return validateWorkflowTask(context.store, selected);
      }),
  );

  server.registerTool(
    "llmatic_workflow_sync_task",
    {
      description:
        "Write a provider-native comment/note and/or transition to the selected workflow task. MCP never self-approves taskWrite=ask.",
      inputSchema: z.object({
        root: z.string().optional(),
        provider: taskProviderSchema.optional(),
        comment: z.string().min(1).optional(),
        transition: z.string().min(1).optional(),
      }),
    },
    async ({ root, provider, comment, transition }) =>
      toolResult(async () => {
        const context = await runtimeContext(root);
        const selected = await resolveWorkflowTaskProvider(
          context.root,
          context.config,
          context.store,
          provider ?? "auto",
        );
        return syncWorkflowTask(context.store, selected, {
          comment,
          transition,
        });
      }),
  );

  server.registerTool(
    "llmatic_plan_status",
    {
      description:
        "Read the current private project-plan pointer and manifest. Does not read or mutate tracked repository files.",
      inputSchema: z.object({
        root: z.string().optional(),
      }),
    },
    async ({ root }) =>
      toolResult(async () => {
        const projectRoot = runtimeRoot(root);
        const workspaceDirectory = planningWorkspaceDirectory(projectRoot);
        const current = await loadCurrentProjectPlan(workspaceDirectory);
        const manifest = current
          ? await loadProjectPlanManifest(workspaceDirectory, current.planId)
          : undefined;

        return {
          current: current ?? null,
          manifest: manifest ?? null,
        };
      }),
  );

  server.registerTool(
    "llmatic_plan_generate",
    {
      description:
        "Generate a new versioned private engineering-plan draft from a completed discovery session. This writes only LLMatic private workspace storage, never tracked project files.",
      inputSchema: z.object({
        root: z.string().optional(),
      }),
    },
    async ({ root }) =>
      toolResult(async () => {
        const projectRoot = runtimeRoot(root);
        const workspaceDirectory = planningWorkspaceDirectory(projectRoot);
        const discovery = await loadDiscoverySession(workspaceDirectory);

        if (!discovery) {
          throw new Error(
            "No discovery session exists. Complete project discovery before generating a plan.",
          );
        }

        return generateProjectPlan(workspaceDirectory, discovery);
      }),
  );

  server.registerTool(
    "llmatic_plan_read_artifact",
    {
      description:
        "Read one artifact from a versioned private project-plan draft by its manifest relative path.",
      inputSchema: z.object({
        root: z.string().optional(),
        planId: z.string().uuid().optional(),
        relativePath: z.string().min(1),
      }),
    },
    async ({ root, planId, relativePath }) =>
      toolResult(async () => {
        const projectRoot = runtimeRoot(root);
        const workspaceDirectory = planningWorkspaceDirectory(projectRoot);
        return {
          planId: planId ?? (await loadCurrentProjectPlan(workspaceDirectory))?.planId ?? null,
          relativePath,
          content: await readProjectPlanArtifact(
            workspaceDirectory,
            relativePath,
            planId,
          ),
        };
      }),
  );

  server.registerTool(
    "llmatic_jira_get",
    {
      description:
        "Read a Jira Cloud issue using environment-provided credentials and taskRead permission.",
      inputSchema: z.object({
        root: z.string().optional(),
        key: z.string().min(1),
      }),
    },
    async ({ root, key }) =>
      toolResult(async () => {
        const context = await runtimeContext(root);
        const provider = createJiraTaskProviderFromEnvironment(context.config);
        return provider.getTask(key);
      }),
  );

  server.registerTool(
    "llmatic_jira_transitions",
    {
      description: "List transitions currently available for a Jira Cloud issue.",
      inputSchema: z.object({
        root: z.string().optional(),
        key: z.string().min(1),
      }),
    },
    async ({ root, key }) =>
      toolResult(async () => {
        const context = await runtimeContext(root);
        const provider = createJiraTaskProviderFromEnvironment(context.config);
        return provider.listTransitions(key);
      }),
  );

  server.registerTool(
    "llmatic_jira_comment",
    {
      description:
        "Add a Jira comment through taskWrite permission. MCP does not self-approve ask permissions.",
      inputSchema: z.object({
        root: z.string().optional(),
        key: z.string().min(1),
        text: z.string().min(1),
      }),
    },
    async ({ root, key, text }) =>
      toolResult(async () => {
        const context = await runtimeContext(root);
        const provider = createJiraTaskProviderFromEnvironment(context.config);
        await provider.addComment(key, text);
        return { key, commented: true };
      }),
  );

  server.registerTool(
    "llmatic_jira_transition",
    {
      description:
        "Transition a Jira issue through taskWrite permission. MCP does not self-approve ask permissions.",
      inputSchema: z.object({
        root: z.string().optional(),
        key: z.string().min(1),
        transition: z.string().min(1),
      }),
    },
    async ({ root, key, transition }) =>
      toolResult(async () => {
        const context = await runtimeContext(root);
        const provider = createJiraTaskProviderFromEnvironment(context.config);
        return provider.transitionTask(key, transition);
      }),
  );

  server.registerTool(
    "llmatic_workflow_select_jira",
    {
      description: "Read a Jira task and start a new workflow in TASK_SELECTED.",
      inputSchema: z.object({
        root: z.string().optional(),
        key: z.string().min(1),
      }),
    },
    async ({ root, key }) =>
      toolResult(async () => {
        const context = await runtimeContext(root);
        const provider = createJiraTaskProviderFromEnvironment(context.config);
        return selectJiraWorkflowTask(context.store, provider, key);
      }),
  );

  server.registerTool(
    "llmatic_workflow_validate_jira",
    {
      description: "Refresh the selected Jira task and advance TASK_SELECTED to TASK_VALIDATED.",
      inputSchema: z.object({
        root: z.string().optional(),
      }),
    },
    async ({ root }) =>
      toolResult(async () => {
        const context = await runtimeContext(root);
        const provider = createJiraTaskProviderFromEnvironment(context.config);
        return validateJiraWorkflowTask(context.store, provider);
      }),
  );

  server.registerTool(
    "llmatic_workflow_sync_jira",
    {
      description:
        "Write a comment and/or transition back to the selected Jira task through taskWrite permission.",
      inputSchema: z.object({
        root: z.string().optional(),
        comment: z.string().min(1).optional(),
        transition: z.string().min(1).optional(),
      }),
    },
    async ({ root, comment, transition }) =>
      toolResult(async () => {
        const context = await runtimeContext(root);
        const provider = createJiraTaskProviderFromEnvironment(context.config);
        return syncJiraWorkflowTask(context.store, provider, { comment, transition });
      }),
  );

  server.registerTool(
    "llmatic_detect",
    {
      description: "Detect repository technologies, package manager, and executable capabilities.",
      inputSchema: z.object({
        root: z.string().optional(),
      }),
    },
    async ({ root }) => toolResult(() => detectRepository(runtimeRoot(root))),
  );

  server.registerTool(
    "llmatic_workflow_status",
    {
      description: "Read the current persistent LLMatic workflow state.",
      inputSchema: z.object({
        root: z.string().optional(),
      }),
    },
    async ({ root }) =>
      toolResult(async () => {
        const context = await runtimeContext(root);
        return (await context.store.loadCurrent()) ?? null;
      }),
  );

  server.registerTool(
    "llmatic_workflow_start",
    {
      description: "Start a new persistent workflow for a task reference.",
      inputSchema: z.object({
        root: z.string().optional(),
        task: z.string().min(1),
      }),
    },
    async ({ root, task }) =>
      toolResult(async () => {
        const context = await runtimeContext(root);
        return startWorkflow(context.store, task);
      }),
  );

  server.registerTool(
    "llmatic_workflow_transition",
    {
      description: "Move the active workflow through a valid state-machine transition.",
      inputSchema: z.object({
        root: z.string().optional(),
        state: workflowStateInputSchema,
      }),
    },
    async ({ root, state }) =>
      toolResult(async () => {
        const context = await runtimeContext(root);
        return transitionWorkflow(context.store, normalizeWorkflowState(state));
      }),
  );

  server.registerTool(
    "llmatic_repo_search",
    {
      description: "Search the cached repository file, AST symbol, and import index.",
      inputSchema: z.object({
        root: z.string().optional(),
        query: z.string().min(1),
        limit: z.number().int().positive().max(100).optional(),
      }),
    },
    async ({ root, query, limit }) =>
      toolResult(async () => {
        const context = await runtimeContext(root);
        const index = await loadRepositoryIndex(context.root, context.config);
        return searchRepositoryIndex(index, query, limit ?? 20);
      }),
  );

  server.registerTool(
    "llmatic_workflow_analyze",
    {
      description:
        "Build repository intelligence and advance TASK_VALIDATED to REPO_ANALYZED. MCP never self-approves repositoryRead=ask.",
      inputSchema: z.object({
        root: z.string().optional(),
      }),
    },
    async ({ root }) =>
      toolResult(async () => {
        const context = await runtimeContext(root);
        return analyzeWorkflowRepository(context.root, context.config, context.store);
      }),
  );

  server.registerTool(
    "llmatic_git_status",
    {
      description: "Read structured Git branch and working-tree status.",
      inputSchema: z.object({
        root: z.string().optional(),
      }),
    },
    async ({ root }) => toolResult(() => getGitStatus(runtimeRoot(root))),
  );

  server.registerTool(
    "llmatic_git_stage",
    {
      description:
        "Stage explicit repository paths through repositoryWrite permission. MCP never self-approves ask permissions.",
      inputSchema: z.object({
        root: z.string().optional(),
        paths: z.array(z.string().min(1)).min(1),
      }),
    },
    async ({ root, paths }) =>
      toolResult(async () => {
        const context = await runtimeContext(root);
        await stagePaths(context.root, context.config, paths);
        return { staged: paths };
      }),
  );

  server.registerTool(
    "llmatic_git_commit",
    {
      description:
        "Commit already staged changes through repositoryWrite permission. Does not stage implicitly.",
      inputSchema: z.object({
        root: z.string().optional(),
        message: z.string().min(1),
      }),
    },
    async ({ root, message }) =>
      toolResult(async () => {
        const context = await runtimeContext(root);
        return commitStagedChanges(context.root, context.config, message);
      }),
  );

  server.registerTool(
    "llmatic_workflow_branch",
    {
      description:
        "Create a workflow branch and advance REPO_ANALYZED to BRANCH_CREATED through repositoryWrite permission.",
      inputSchema: z.object({
        root: z.string().optional(),
        name: z.string().min(1),
      }),
    },
    async ({ root, name }) =>
      toolResult(async () => {
        const context = await runtimeContext(root);
        return createWorkflowBranch(context.root, context.config, context.store, name);
      }),
  );

  server.registerTool(
    "llmatic_run_capability",
    {
      description:
        "Execute a detected repository quality capability and persist its checkpoint. Ask permissions are not self-approved.",
      inputSchema: z.object({
        root: z.string().optional(),
        capability: capabilitySchema,
      }),
    },
    async ({ root, capability }) =>
      toolResult(async () => {
        const context = await runtimeContext(root);
        const result = await executeCapability(
          context.root,
          context.config,
          capability as CapabilityName,
        );
        await recordCapabilityCheckpoint(context.store, result);
        return result;
      }),
  );

  server.registerTool(
    "llmatic_workflow_validate",
    {
      description:
        "Run configured local gates and advance workflow to CODE_REVIEW or FIXING. Ask permissions are not self-approved.",
      inputSchema: z.object({
        root: z.string().optional(),
      }),
    },
    async ({ root }) =>
      toolResult(async () => {
        const context = await runtimeContext(root);
        return runLocalValidation(context.root, context.config, context.store);
      }),
  );

  server.registerTool(
    "llmatic_workflow_push",
    {
      description:
        "Push the workflow branch and advance READY_TO_PUSH to PUSHED. Requires gitPush=auto for MCP automation.",
      inputSchema: z.object({
        root: z.string().optional(),
        remote: z.string().min(1).optional(),
        setUpstream: z.boolean().optional(),
      }),
    },
    async ({ root, remote, setUpstream }) =>
      toolResult(async () => {
        const context = await runtimeContext(root);
        return pushWorkflowBranch(context.root, context.config, context.store, {
          remote,
          setUpstream: setUpstream ?? false,
        });
      }),
  );

  server.registerTool(
    "llmatic_workflow_open_pr",
    {
      description:
        "Create the workflow pull request and advance PUSHED to PR_OPEN. Requires createPullRequest=auto for MCP automation.",
      inputSchema: z.object({
        root: z.string().optional(),
        title: z.string().min(1),
        body: z.string().optional(),
        base: z.string().min(1).optional(),
        head: z.string().min(1).optional(),
        draft: z.boolean().optional(),
      }),
    },
    async ({ root, title, body, base, head, draft }) =>
      toolResult(async () => {
        const context = await runtimeContext(root);
        return createWorkflowPullRequest(context.root, context.config, context.store, {
          title,
          body: body ?? "",
          base,
          head,
          draft: draft ?? false,
        });
      }),
  );

  server.registerTool(
    "llmatic_github_pr_status",
    {
      description: "Read GitHub pull-request metadata and normalized remote CI checks.",
      inputSchema: z.object({
        root: z.string().optional(),
        ref: z.string().min(1).optional(),
      }),
    },
    async ({ root, ref }) => toolResult(() => getPullRequestStatus(runtimeRoot(root), ref)),
  );

  server.registerTool(
    "llmatic_workflow_remote_ci",
    {
      description:
        "Refresh GitHub checks and advance PR_OPEN/REMOTE_CI to FINAL_REVIEW, FIXING, or remain REMOTE_CI.",
      inputSchema: z.object({
        root: z.string().optional(),
        ref: z.string().min(1).optional(),
      }),
    },
    async ({ root, ref }) =>
      toolResult(async () => {
        const context = await runtimeContext(root);
        return refreshWorkflowRemoteCi(context.root, context.store, ref);
      }),
  );

  server.registerTool(
    "llmatic_workflow_merge",
    {
      description:
        "Merge the workflow PR with exact head-SHA protection and advance READY_TO_MERGE to COMPLETED. Requires mergePullRequest=auto for MCP automation.",
      inputSchema: z.object({
        root: z.string().optional(),
        ref: z.string().min(1).optional(),
        method: z.enum(["squash", "merge", "rebase"]).optional(),
      }),
    },
    async ({ root, ref, method }) =>
      toolResult(async () => {
        const context = await runtimeContext(root);
        return mergeWorkflowPullRequest(context.root, context.config, context.store, ref, {
          method,
        });
      }),
  );

  server.registerTool(
    "llmatic_runtime_inspect",
    {
      description: "Inspect Docker, Supabase, Python, and Ollama tool-pack availability.",
      inputSchema: z.object({
        root: z.string().optional(),
      }),
    },
    async ({ root }) => toolResult(() => inspectRuntimeTools(runtimeRoot(root))),
  );

  server.registerTool(
    "llmatic_runtime_run",
    {
      description:
        "Run a whitelisted runtime operation. MCP never self-approves docker, databaseMigration, or localProcess ask permissions.",
      inputSchema: z.object({
        root: z.string().optional(),
        pack: z.enum(["docker", "supabase", "python", "ollama"]),
        operation: z.string().min(1),
        script: z.string().min(1).optional(),
        model: z.string().min(1).optional(),
        prompt: z.string().optional(),
        args: z.array(z.string()).optional(),
      }),
    },
    async ({ root, pack, operation, script, model, prompt, args }) =>
      toolResult(async () => {
        const context = await runtimeContext(root);
        const request = parseRuntimeToolOperation(pack, operation, {
          script,
          model,
          prompt,
          args: args ?? [],
        });
        return runRuntimeToolOperation(context.root, context.config, context.store, request);
      }),
  );

  server.registerTool(
    "llmatic_tools_list",
    {
      description:
        "Detect engineering tools known to the LLMatic tool registry without mutating the machine.",
      inputSchema: z.object({
        root: z.string().optional(),
      }),
    },
    async ({ root }) =>
      toolResult(() => detectRegisteredTools(runtimeRoot(root), DEFAULT_TOOL_REGISTRY)),
  );

  return server;
}
