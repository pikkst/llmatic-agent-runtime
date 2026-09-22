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
  PullRequestChangedFile,
  PullRequestCheck,
  PullRequestFileReadOptions,
  PullRequestFileReadResult,
  PullRequestCommentSnapshot,
  PublishPullRequestReviewInput,
  PullRequestReviewContext,
  PullRequestReviewMetadata,
  PullRequestReviewSnapshot,
  PullRequestReviewThreadSnapshot,
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
const PR_REVIEW_FIELDS = [
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
  "title",
  "body",
  "author",
  "reviews",
  "comments",
].join(",");
const MAX_PULL_REQUEST_REVIEW_DIFF_CHARS = 256_000;
const MAX_PULL_REQUEST_TEXT_CHARS = 32_000;
const MAX_PULL_REQUEST_REVIEW_ITEMS = 50;
const MAX_PULL_REQUEST_FILE_CHARS = 64_000;

const PR_REVIEW_THREADS_QUERY = `
query PullRequestReviewThreads($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 50) {
        nodes {
          isResolved
          isOutdated
          path
          line
          originalLine
          comments(first: 50) {
            nodes {
              author {
                login
              }
              body
              createdAt
              url
            }
          }
        }
      }
    }
  }
}
`;

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

  const checks = result.stdout.trim() ? parseJson<PullRequestCheck[]>(result, args) : [];

  return {
    pullRequest,
    checks,
    ciState: ciStateFor(checks),
  };
}

function boundedPullRequestText(value: unknown): string {
  const text = typeof value === "string" ? value : "";
  return text.length <= MAX_PULL_REQUEST_TEXT_CHARS
    ? text
    : text.slice(0, MAX_PULL_REQUEST_TEXT_CHARS) + "\n[TEXT TRUNCATED]";
}

function actorLogin(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const login = (value as Record<string, unknown>).login;
  return typeof login === "string" && login.trim() ? login.trim() : undefined;
}

function normalizeReviewSnapshots(value: unknown): PullRequestReviewSnapshot[] {
  if (!Array.isArray(value)) return [];

  return value.slice(-MAX_PULL_REQUEST_REVIEW_ITEMS).map((item) => {
    const raw =
      item && typeof item === "object" && !Array.isArray(item)
        ? (item as Record<string, unknown>)
        : {};
    return {
      authorLogin: actorLogin(raw.author),
      state: typeof raw.state === "string" ? raw.state : undefined,
      body: boundedPullRequestText(raw.body),
      submittedAt: typeof raw.submittedAt === "string" ? raw.submittedAt : undefined,
    };
  });
}

function normalizeCommentSnapshots(value: unknown): PullRequestCommentSnapshot[] {
  if (!Array.isArray(value)) return [];

  return value.slice(-MAX_PULL_REQUEST_REVIEW_ITEMS).map((item) => {
    const raw =
      item && typeof item === "object" && !Array.isArray(item)
        ? (item as Record<string, unknown>)
        : {};
    return {
      authorLogin: actorLogin(raw.author),
      body: boundedPullRequestText(raw.body),
      createdAt: typeof raw.createdAt === "string" ? raw.createdAt : undefined,
      url: typeof raw.url === "string" ? raw.url : undefined,
    };
  });
}

function normalizeReviewThreads(value: unknown): PullRequestReviewThreadSnapshot[] {
  if (!Array.isArray(value)) return [];

  return value
    .slice(0, MAX_PULL_REQUEST_REVIEW_ITEMS)
    .map((item) => {
      const raw =
        item && typeof item === "object" && !Array.isArray(item)
          ? (item as Record<string, unknown>)
          : {};
      const commentsContainer =
        raw.comments && typeof raw.comments === "object" && !Array.isArray(raw.comments)
          ? (raw.comments as Record<string, unknown>)
          : {};

      return {
        path: typeof raw.path === "string" ? raw.path.replaceAll("\\", "/") : "",
        line: typeof raw.line === "number" ? raw.line : undefined,
        originalLine: typeof raw.originalLine === "number" ? raw.originalLine : undefined,
        resolved: Boolean(raw.isResolved),
        outdated: Boolean(raw.isOutdated),
        comments: normalizeCommentSnapshots(commentsContainer.nodes),
      };
    })
    .filter((thread) => Boolean(thread.path));
}

interface PullRequestCoordinates {
  owner: string;
  name: string;
  number: number;
}

function pullRequestCoordinates(pullRequest: PullRequestSummary): PullRequestCoordinates {
  let pullRequestUrl: URL;
  try {
    pullRequestUrl = new URL(pullRequest.url);
  } catch {
    throw new Error("Pull-request URL is invalid and cannot resolve its repository.");
  }

  const pathParts = pullRequestUrl.pathname.split("/").filter(Boolean);
  const [owner, name, pullSegment, numberSegment] = pathParts;
  const number = Number(numberSegment);
  if (
    !owner ||
    !name ||
    pullSegment !== "pull" ||
    !Number.isInteger(number) ||
    number <= 0 ||
    number !== pullRequest.number
  ) {
    throw new Error("Pull-request repository/number could not be resolved from its canonical URL.");
  }

  return { owner, name, number };
}

function assertPullRequestMatchesWorkspaceRepository(
  root: string,
  pullRequest: PullRequestSummary,
  runner: GitHubProcessRunner,
): void {
  const target = pullRequestCoordinates(pullRequest);
  const args = ["repo", "view", "--json", "nameWithOwner"];
  const repository = parseJson<{ nameWithOwner?: string }>(
    requireSuccess(run(root, args, runner), args),
    args,
  );
  const workspaceNameWithOwner = String(repository.nameWithOwner ?? "").trim();
  const targetNameWithOwner = target.owner + "/" + target.name;

  if (
    !workspaceNameWithOwner ||
    workspaceNameWithOwner.toLowerCase() !== targetNameWithOwner.toLowerCase()
  ) {
    throw new Error(
      "External pull-request review must target the opened repository. Workspace: " +
        (workspaceNameWithOwner || "unknown") +
        "; target: " +
        targetNameWithOwner +
        ".",
    );
  }
}

function readPullRequestChangedFiles(
  root: string,
  pullRequest: PullRequestSummary,
  runner: GitHubProcessRunner,
): PullRequestChangedFile[] {
  const { owner, name, number } = pullRequestCoordinates(pullRequest);
  const args = [
    "api",
    "--paginate",
    "--slurp",
    "repos/" + owner + "/" + name + "/pulls/" + String(number) + "/files?per_page=100",
  ];
  const pages = parseJson<unknown[]>(requireSuccess(run(root, args, runner), args), args);
  const rawFiles = pages.flatMap((page) => (Array.isArray(page) ? page : []));

  return rawFiles
    .map((item) => {
      const file =
        item && typeof item === "object" && !Array.isArray(item)
          ? (item as Record<string, unknown>)
          : {};
      return {
        path: typeof file.filename === "string" ? file.filename.replaceAll("\\", "/") : "",
        additions: typeof file.additions === "number" ? file.additions : 0,
        deletions: typeof file.deletions === "number" ? file.deletions : 0,
      };
    })
    .filter((file) => Boolean(file.path));
}

function readPullRequestReviewThreads(
  root: string,
  pullRequest: PullRequestSummary,
  runner: GitHubProcessRunner,
): PullRequestReviewThreadSnapshot[] {
  const { owner, name, number } = pullRequestCoordinates(pullRequest);

  const args = [
    "api",
    "graphql",
    "-f",
    "query=" + PR_REVIEW_THREADS_QUERY,
    "-f",
    "owner=" + owner,
    "-f",
    "name=" + name,
    "-F",
    "number=" + String(number),
  ];
  const result = parseJson<{
    data?: {
      repository?: {
        pullRequest?: {
          reviewThreads?: {
            nodes?: unknown[];
          };
        };
      };
    };
  }>(requireSuccess(run(root, args, runner), args), args);

  return normalizeReviewThreads(result.data?.repository?.pullRequest?.reviewThreads?.nodes);
}

/**
 * Reads bounded pull-request metadata for explicit external review without
 * downloading unified diff bytes or mutating local/remote workflow state.
 */
export async function getPullRequestReviewMetadata(
  root: string,
  ref: string | number,
  runner: GitHubProcessRunner = defaultRunner,
): Promise<PullRequestReviewMetadata> {
  const status = await getPullRequestStatus(root, ref, runner);
  assertPullRequestMatchesWorkspaceRepository(root, status.pullRequest, runner);

  const target = ref || status.pullRequest.number;
  const viewArgs = [...prArgs("view", target), "--json", PR_REVIEW_FIELDS];
  const raw = parseJson<Record<string, unknown>>(
    requireSuccess(run(root, viewArgs, runner), viewArgs),
    viewArgs,
  );
  const changedFiles = readPullRequestChangedFiles(root, status.pullRequest, runner);
  const reviewThreads = readPullRequestReviewThreads(root, status.pullRequest, runner);

  return {
    status,
    title: typeof raw.title === "string" ? raw.title : "",
    body: boundedPullRequestText(raw.body),
    authorLogin: actorLogin(raw.author),
    changedFiles,
    reviews: normalizeReviewSnapshots(raw.reviews),
    comments: normalizeCommentSnapshots(raw.comments),
    reviewThreads,
  };
}

export function readPullRequestFileAtHead(
  root: string,
  pullRequest: PullRequestSummary,
  path: string,
  options: PullRequestFileReadOptions = {},
  runner: GitHubProcessRunner = defaultRunner,
): PullRequestFileReadResult {
  assertPullRequestMatchesWorkspaceRepository(root, pullRequest, runner);

  const normalizedPath = path.replaceAll("\\", "/").replace(/^\/+/, "");
  if (!normalizedPath) {
    throw new Error("Pull-request file path is required.");
  }

  const { owner, name } = pullRequestCoordinates(pullRequest);
  const encodedPath = normalizedPath
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  const args = [
    "api",
    "repos/" +
      owner +
      "/" +
      name +
      "/contents/" +
      encodedPath +
      "?ref=" +
      encodeURIComponent(pullRequest.headRefOid),
  ];
  const raw = parseJson<Record<string, unknown>>(
    requireSuccess(run(root, args, runner), args),
    args,
  );

  if (raw.type !== "file" || raw.encoding !== "base64" || typeof raw.content !== "string") {
    throw new Error("Target pull-request path is not a readable text file: " + normalizedPath + ".");
  }

  const decoded = Buffer.from(raw.content.replace(/\s+/g, ""), "base64").toString("utf8");
  if (decoded.includes("\u0000")) {
    throw new Error("Target pull-request path appears to be binary: " + normalizedPath + ".");
  }

  const lines = decoded.split(/\r?\n/);
  const totalLines = lines.length;
  const startLine = Math.max(1, Math.floor(options.startLine ?? 1));
  const requestedEnd = Math.floor(options.endLine ?? totalLines);
  const endLine = Math.max(startLine, Math.min(totalLines, requestedEnd));
  const selected = lines.slice(startLine - 1, endLine).join("\n");
  const truncated = selected.length > MAX_PULL_REQUEST_FILE_CHARS;

  return {
    path: normalizedPath,
    ref: pullRequest.headRefOid,
    startLine,
    endLine,
    totalLines,
    content: truncated
      ? selected.slice(0, MAX_PULL_REQUEST_FILE_CHARS) + "\n[FILE TRUNCATED]"
      : selected,
    truncated,
  };
}

/**
 * Adds the bounded unified diff used by the explicit structured review flow.
 */
export async function getPullRequestReviewContext(
  root: string,
  ref: string | number,
  runner: GitHubProcessRunner = defaultRunner,
): Promise<PullRequestReviewContext> {
  const metadata = await getPullRequestReviewMetadata(root, ref, runner);
  const target = ref || metadata.status.pullRequest.number;
  const diffArgs = [...prArgs("diff", target), "--color", "never"];
  const rawDiff = requireSuccess(run(root, diffArgs, runner), diffArgs).stdout;
  const diffTruncated = rawDiff.length > MAX_PULL_REQUEST_REVIEW_DIFF_CHARS;

  return {
    ...metadata,
    diff: diffTruncated
      ? rawDiff.slice(0, MAX_PULL_REQUEST_REVIEW_DIFF_CHARS) + "\n[DIFF TRUNCATED]"
      : rawDiff,
    diffTruncated,
  };
}

export interface FailedPullRequestCheckLog {
  check: PullRequestCheck;
  runId?: string;
  log?: string;
  error?: string;
}

export interface FailedPullRequestDiagnostics {
  status: PullRequestStatus;
  failed: FailedPullRequestCheckLog[];
}

const MAX_FAILED_LOG_CHARS = 96_000;

function actionsRunId(link: string | undefined): string | undefined {
  if (!link) return undefined;
  return /\/actions\/runs\/(\d+)/.exec(link)?.[1];
}

export async function getFailedPullRequestDiagnostics(
  root: string,
  ref?: string | number,
  runner: GitHubProcessRunner = defaultRunner,
): Promise<FailedPullRequestDiagnostics> {
  const status = await getPullRequestStatus(root, ref, runner);
  const failedChecks = status.checks.filter(
    (check) => check.bucket === "fail" || check.bucket === "cancel",
  );

  const failed: FailedPullRequestCheckLog[] = [];
  const logCache = new Map<string, { log?: string; error?: string }>();

  for (const check of failedChecks) {
    const runId = actionsRunId(check.link);
    if (!runId) {
      failed.push({
        check,
        error: "GitHub Actions run id could not be resolved from the check link.",
      });
      continue;
    }

    let cached = logCache.get(runId);
    if (!cached) {
      const args = ["run", "view", runId, "--log-failed"];
      const result = run(root, args, runner);
      cached =
        result.exitCode === 0
          ? {
              log:
                result.stdout.length <= MAX_FAILED_LOG_CHARS
                  ? result.stdout
                  : result.stdout.slice(0, MAX_FAILED_LOG_CHARS) + "\n[LOG TRUNCATED]",
            }
          : {
              error:
                (result.stderr || result.stdout).trim() ||
                "Unable to read failed GitHub Actions logs.",
            };
      logCache.set(runId, cached);
    }

    failed.push({
      check,
      runId,
      ...cached,
    });
  }

  return { status, failed };
}

export async function publishPullRequestReview(
  root: string,
  config: AgentConfig,
  ref: string | number,
  input: PublishPullRequestReviewInput,
  options: GitHubMutationOptions = {},
): Promise<void> {
  const body = input.body.trim();
  if (!body) {
    throw new Error("Pull-request review body is required.");
  }

  assertPermission(
    config.permissions.pullRequestReview,
    "Pull-request review publication",
    options.approved === true,
  );

  const target = normalizeRef(ref);
  if (!target) {
    throw new Error("Pull-request review reference is required.");
  }

  const args = ["pr", "review", target, "--comment", "--body", body];
  requireSuccess(run(root, args, runnerFor(options)), args);
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
