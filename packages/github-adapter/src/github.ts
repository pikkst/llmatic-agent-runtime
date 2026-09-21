import { spawnSync } from "node:child_process";
import type { AgentConfig, WorkflowRun, WorkflowStateStore } from "@llmatic/core";
import { recordActionCheckpoint, transitionWorkflow } from "@llmatic/core";
import type {
  CreatePullRequestInput,
  GitHubMutationOptions,
  GitHubProcessResult,
  GitHubProcessRunner,
  MergeMethod,
  MergePullRequestOptions,
  MergePullRequestResult,
  PullRequestCheck,
  PullRequestStatus,
  PullRequestSummary,
  RemoteCiState,
} from "./types.js";

const PR_VIEW_FIELDS = [
  "number",
  "url",
  "state",
  "isDraft",
  "mergeable",
  "mergeStateStatus",
  "reviewDecision",
  "headRefName",
  "headRefOid",
  "baseRefName",
].join(",");

const PR_CHECK_FIELDS = ["name", "state", "bucket", "workflow", "link"].join(",");

function defaultRunner(executable: string, args: string[], cwd: string): GitHubProcessResult {
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

function runnerFor(options?: GitHubMutationOptions): GitHubProcessRunner {
  return options?.runner ?? defaultRunner;
}

function displayCommand(args: string[]): string {
  return ["gh", ...args].join(" ");
}

function run(root: string, args: string[], runner: GitHubProcessRunner): GitHubProcessResult {
  return runner("gh", args, root);
}

function requireSuccess(result: GitHubProcessResult, args: string[]): GitHubProcessResult {
  if (result.exitCode !== 0) {
    const detail = (result.stderr || result.stdout).trim();
    throw new Error(
      "GitHub CLI command failed: " +
        displayCommand(args) +
        " (exit " +
        result.exitCode +
        ")" +
        (detail ? ": " + detail : ""),
    );
  }

  return result;
}

function assertPermission(
  permission: AgentConfig["permissions"]["createPullRequest"],
  permissionName: string,
  approved: boolean,
): void {
  if (permission === "deny") {
    throw new Error(permissionName + " is denied by llmatic.agent.yaml.");
  }

  if (permission === "ask" && !approved) {
    throw new Error(
      permissionName + " requires approval. Re-run with --approve after reviewing the operation.",
    );
  }
}

function normalizeRef(ref?: string | number): string | undefined {
  if (ref === undefined) return undefined;
  const value = String(ref).trim();
  return value || undefined;
}

function prArgs(command: string, ref?: string | number): string[] {
  const normalized = normalizeRef(ref);
  return normalized ? ["pr", command, normalized] : ["pr", command];
}

function parseJson<T>(result: GitHubProcessResult, args: string[]): T {
  try {
    return JSON.parse(result.stdout) as T;
  } catch (error) {
    throw new Error(
      "GitHub CLI returned invalid JSON for " +
        displayCommand(args) +
        ": " +
        (error instanceof Error ? error.message : String(error)),
    );
  }
}

function normalizePullRequest(raw: Record<string, unknown>): PullRequestSummary {
  return {
    number: Number(raw.number),
    url: String(raw.url ?? ""),
    state: String(raw.state ?? ""),
    isDraft: Boolean(raw.isDraft),
    mergeable: String(raw.mergeable ?? "UNKNOWN"),
    mergeStateStatus: String(raw.mergeStateStatus ?? "UNKNOWN"),
    reviewDecision:
      raw.reviewDecision === null || raw.reviewDecision === undefined
        ? undefined
        : String(raw.reviewDecision),
    headRefName: String(raw.headRefName ?? ""),
    headRefOid: String(raw.headRefOid ?? ""),
    baseRefName: String(raw.baseRefName ?? ""),
  };
}

function ciStateFor(checks: PullRequestCheck[]): RemoteCiState {
  if (checks.some((check) => check.bucket === "fail")) return "failing";
  if (checks.some((check) => check.bucket === "cancel")) return "cancelled";
  if (checks.some((check) => check.bucket === "pending")) return "pending";
  if (checks.length === 0) return "none";
  return "passing";
}

export function normalizeMergeMethod(input: string | undefined): MergeMethod {
  const method = (input ?? "squash").trim().toLowerCase();

  if (method === "squash" || method === "merge" || method === "rebase") {
    return method;
  }

  throw new Error("Merge method must be squash, merge, or rebase.");
}

export async function getPullRequestSummary(
  root: string,
  ref?: string | number,
  runner: GitHubProcessRunner = defaultRunner,
): Promise<PullRequestSummary> {
  const args = [...prArgs("view", ref), "--json", PR_VIEW_FIELDS];
  const result = requireSuccess(run(root, args, runner), args);
  return normalizePullRequest(parseJson<Record<string, unknown>>(result, args));
}

export async function getPullRequestStatus(
  root: string,
  ref?: string | number,
  runner: GitHubProcessRunner = defaultRunner,
): Promise<PullRequestStatus> {
  const pullRequest = await getPullRequestSummary(root, ref, runner);
  const args = [...prArgs("checks", ref ?? pullRequest.number), "--json", PR_CHECK_FIELDS];
  const result = run(root, args, runner);

  if (![0, 1, 8].includes(result.exitCode)) {
    requireSuccess(result, args);
  }

  const checks = parseJson<PullRequestCheck[]>(result, args);

  return {
    pullRequest,
    checks,
    ciState: ciStateFor(checks),
  };
}

export async function createPullRequest(
  root: string,
  config: AgentConfig,
  input: CreatePullRequestInput,
  options: GitHubMutationOptions = {},
): Promise<PullRequestSummary> {
  if (!input.title.trim()) {
    throw new Error("Pull-request title must not be empty.");
  }

  assertPermission(
    config.permissions.createPullRequest,
    "Pull-request creation",
    options.approved ?? false,
  );

  const runner = runnerFor(options);
  const args = ["pr", "create", "--title", input.title.trim(), "--body", input.body];

  if (input.base?.trim()) args.push("--base", input.base.trim());
  if (input.head?.trim()) args.push("--head", input.head.trim());
  if (input.draft) args.push("--draft");

  const result = requireSuccess(run(root, args, runner), args);
  const url = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => /^https?:\/\//.test(line));

  if (!url) {
    throw new Error("GitHub CLI created a pull request but did not return its URL.");
  }

  return getPullRequestSummary(root, url, runner);
}

export async function mergePullRequest(
  root: string,
  config: AgentConfig,
  ref: string | number | undefined,
  options: MergePullRequestOptions = {},
): Promise<MergePullRequestResult> {
  assertPermission(
    config.permissions.mergePullRequest,
    "Pull-request merge",
    options.approved ?? false,
  );

  const runner = runnerFor(options);
  const pullRequest = await getPullRequestSummary(root, ref, runner);

  if (pullRequest.state !== "OPEN") {
    throw new Error("Pull request #" + pullRequest.number + " is not open.");
  }

  if (pullRequest.isDraft) {
    throw new Error("Draft pull request #" + pullRequest.number + " cannot be merged.");
  }

  if (!pullRequest.headRefOid) {
    throw new Error("Pull request head SHA is missing.");
  }

  const method = normalizeMergeMethod(options.method);
  const methodFlag = method === "squash" ? "--squash" : method === "merge" ? "--merge" : "--rebase";
  const args = [
    "pr",
    "merge",
    String(pullRequest.number),
    methodFlag,
    "--match-head-commit",
    pullRequest.headRefOid,
  ];

  requireSuccess(run(root, args, runner), args);

  return {
    pullRequest,
    method,
  };
}

function latestWorkflowPullRequestRef(run: WorkflowRun): string | undefined {
  for (let index = run.checkpoints.length - 1; index >= 0; index -= 1) {
    const checkpoint = run.checkpoints[index];

    if (
      checkpoint?.kind === "ACTION" &&
      checkpoint.provider === "github" &&
      checkpoint.action === "pr.create" &&
      checkpoint.success
    ) {
      return checkpoint.metadata?.prNumber ?? checkpoint.metadata?.url;
    }
  }

  return undefined;
}

async function workflowPullRequestRef(
  store: WorkflowStateStore,
  explicitRef?: string,
): Promise<string> {
  const current = await store.loadCurrent();

  if (!current) {
    throw new Error("No workflow is active.");
  }

  const ref = explicitRef?.trim() || latestWorkflowPullRequestRef(current);

  if (!ref) {
    throw new Error(
      "Workflow has no recorded pull request. Pass --pr or create it with llmatic workflow open-pr.",
    );
  }

  return ref;
}

export async function createWorkflowPullRequest(
  root: string,
  config: AgentConfig,
  store: WorkflowStateStore,
  input: CreatePullRequestInput,
  options: GitHubMutationOptions = {},
): Promise<{ pullRequest: PullRequestSummary; workflow: WorkflowRun }> {
  const current = await store.loadCurrent();

  if (!current || current.state !== "PUSHED") {
    throw new Error("Workflow pull-request creation requires state PUSHED.");
  }

  try {
    const pullRequest = await createPullRequest(root, config, input, options);

    await recordActionCheckpoint(store, {
      provider: "github",
      action: "pr.create",
      command: "gh pr create",
      success: true,
      detail: pullRequest.url,
      metadata: {
        prNumber: String(pullRequest.number),
        url: pullRequest.url,
        headRefOid: pullRequest.headRefOid,
      },
    });

    const workflow = await transitionWorkflow(store, "PR_OPEN");
    return { pullRequest, workflow };
  } catch (error) {
    await recordActionCheckpoint(store, {
      provider: "github",
      action: "pr.create",
      command: "gh pr create",
      success: false,
      detail: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

export async function refreshWorkflowRemoteCi(
  root: string,
  store: WorkflowStateStore,
  explicitRef?: string,
  runner: GitHubProcessRunner = defaultRunner,
): Promise<{ status: PullRequestStatus; workflow: WorkflowRun }> {
  let current = await store.loadCurrent();

  if (!current || (current.state !== "PR_OPEN" && current.state !== "REMOTE_CI")) {
    throw new Error("Remote CI refresh requires state PR_OPEN or REMOTE_CI.");
  }

  const ref = await workflowPullRequestRef(store, explicitRef);
  const status = await getPullRequestStatus(root, ref, runner);

  await recordActionCheckpoint(store, {
    provider: "github",
    action: "pr.checks",
    command: "gh pr checks " + ref,
    success: status.ciState === "passing",
    detail: status.ciState,
    metadata: {
      prNumber: String(status.pullRequest.number),
      headRefOid: status.pullRequest.headRefOid,
      ciState: status.ciState,
    },
  });

  if (current.state === "PR_OPEN") {
    current = await transitionWorkflow(store, "REMOTE_CI");
  }

  if (status.ciState === "passing") {
    current = await transitionWorkflow(store, "FINAL_REVIEW");
  } else if (status.ciState === "failing" || status.ciState === "cancelled") {
    current = await transitionWorkflow(store, "FIXING");
  }

  return { status, workflow: current };
}

export async function mergeWorkflowPullRequest(
  root: string,
  config: AgentConfig,
  store: WorkflowStateStore,
  explicitRef?: string,
  options: MergePullRequestOptions = {},
): Promise<{ merge: MergePullRequestResult; workflow: WorkflowRun }> {
  const current = await store.loadCurrent();

  if (!current || current.state !== "READY_TO_MERGE") {
    throw new Error("Workflow pull-request merge requires state READY_TO_MERGE.");
  }

  const ref = await workflowPullRequestRef(store, explicitRef);

  try {
    const merge = await mergePullRequest(root, config, ref, options);

    await recordActionCheckpoint(store, {
      provider: "github",
      action: "pr.merge",
      command:
        "gh pr merge " +
        merge.pullRequest.number +
        " --" +
        merge.method +
        " --match-head-commit " +
        merge.pullRequest.headRefOid,
      success: true,
      detail: merge.pullRequest.url,
      metadata: {
        prNumber: String(merge.pullRequest.number),
        headRefOid: merge.pullRequest.headRefOid,
        method: merge.method,
      },
    });

    const workflow = await transitionWorkflow(store, "COMPLETED");
    return { merge, workflow };
  } catch (error) {
    await recordActionCheckpoint(store, {
      provider: "github",
      action: "pr.merge",
      success: false,
      detail: error instanceof Error ? error.message : String(error),
      metadata: { prRef: ref },
    });
    throw error;
  }
}
