import { createHash, randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import {
  inspectBootstrap,
  remediateBootstrap,
  type BootstrapReport,
} from "@llmatic/bootstrap-manager";
import {
  WorkflowStateStore,
  type AgentConfig,
  type WorkflowRun,
} from "@llmatic/core";
import {
  loadDiscoverySession,
  type DiscoverySession,
} from "@llmatic/discovery-engine";
import { createMarkdownTaskProvider } from "@llmatic/markdown-task-source";
import {
  loadCurrentProjectPlan,
  loadProjectPlanManifest,
  planDirectory,
  type ProjectPlanManifest,
} from "@llmatic/planning-engine";
import { selectWorkflowTask } from "@llmatic/task-provider";

export type ProjectLifecycleState =
  | "EMPTY_REPO"
  | "IDEA_CAPTURED"
  | "REQUIREMENTS_DRAFTED"
  | "ARCHITECTURE_DRAFTED"
  | "ROADMAP_DRAFTED"
  | "TASK_GRAPH_DRAFTED"
  | "PLAN_REVIEW"
  | "APPROVED"
  | "PROJECT_INITIALIZING"
  | "FOUNDATION_VALIDATION"
  | "READY_FOR_IMPLEMENTATION"
  | "FAILED";

export interface ProjectLifecycleCheckpoint {
  state: ProjectLifecycleState;
  at: string;
  detail?: string;
}

export interface ProjectLifecycle {
  version: 1;
  planId: string;
  state: ProjectLifecycleState;
  createdAt: string;
  updatedAt: string;
  history: ProjectLifecycleCheckpoint[];
  lastError?: string;
}

export interface ProjectApproval {
  version: 1;
  planId: string;
  planDigest: string;
  approvedAt: string;
  approvedBy: "user";
  discoverySessionId: string;
}

export interface PlanApprovalStatus {
  currentPlanId?: string;
  approval?: ProjectApproval;
  currentDigest?: string;
  verified: boolean;
  reason?: string;
  lifecycle?: ProjectLifecycle;
}

export interface PlanChangeRequest {
  version: 1;
  planId: string;
  requestedAt: string;
  requestedBy: "user";
  text: string;
}

export interface ProjectInitializationResult {
  planId: string;
  planDigest: string;
  lifecycle: ProjectLifecycle;
  materializedFiles: string[];
  scaffoldFiles: string[];
  bootstrap: BootstrapReport;
  nextTaskKey: string;
  workflow: WorkflowRun;
}

const GREENFIELD_ALLOWED = new Set([
  ".git",
  ".gitignore",
  ".gitattributes",
  ".editorconfig",
  "README",
  "README.md",
  "README.txt",
  "LICENSE",
  "LICENSE.md",
]);

const INITIAL_PLAN_REVIEW_STATES: ProjectLifecycleState[] = [
  "EMPTY_REPO",
  "IDEA_CAPTURED",
  "REQUIREMENTS_DRAFTED",
  "ARCHITECTURE_DRAFTED",
  "ROADMAP_DRAFTED",
  "TASK_GRAPH_DRAFTED",
  "PLAN_REVIEW",
];

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function writeAtomic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = path + "." + randomUUID() + ".tmp";
  await writeFile(temporary, content, "utf8");

  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function planningPath(workspaceDirectory: string, name: string): string {
  return resolve(workspaceDirectory, "planning", name);
}

export function projectApprovalPath(workspaceDirectory: string): string {
  return planningPath(workspaceDirectory, "approval.json");
}

export function projectLifecyclePath(workspaceDirectory: string): string {
  return planningPath(workspaceDirectory, "project-lifecycle.json");
}

export function projectChangeRequestPath(workspaceDirectory: string): string {
  return planningPath(workspaceDirectory, "change-request.json");
}

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    const code =
      error instanceof Error && "code" in error
        ? String(error.code)
        : undefined;
    if (code === "ENOENT") return undefined;
    throw error;
  }
}

export async function loadProjectApproval(
  workspaceDirectory: string,
): Promise<ProjectApproval | undefined> {
  return readJson<ProjectApproval>(projectApprovalPath(workspaceDirectory));
}

export async function loadProjectLifecycle(
  workspaceDirectory: string,
): Promise<ProjectLifecycle | undefined> {
  return readJson<ProjectLifecycle>(projectLifecyclePath(workspaceDirectory));
}

async function saveLifecycle(
  workspaceDirectory: string,
  lifecycle: ProjectLifecycle,
): Promise<ProjectLifecycle> {
  await writeAtomic(
    projectLifecyclePath(workspaceDirectory),
    JSON.stringify(lifecycle, null, 2) + "\n",
  );
  return lifecycle;
}

function createPlanReviewLifecycle(
  planId: string,
  now = new Date().toISOString(),
): ProjectLifecycle {
  return {
    version: 1,
    planId,
    state: "PLAN_REVIEW",
    createdAt: now,
    updatedAt: now,
    history: INITIAL_PLAN_REVIEW_STATES.map((state) => ({
      state,
      at: now,
    })),
  };
}

async function lifecycleForPlan(
  workspaceDirectory: string,
  planId: string,
): Promise<ProjectLifecycle> {
  const existing = await loadProjectLifecycle(workspaceDirectory);
  if (existing?.planId === planId) return existing;

  return saveLifecycle(
    workspaceDirectory,
    createPlanReviewLifecycle(planId),
  );
}

async function transitionLifecycle(
  workspaceDirectory: string,
  lifecycle: ProjectLifecycle,
  state: ProjectLifecycleState,
  detail?: string,
): Promise<ProjectLifecycle> {
  const now = new Date().toISOString();
  const updated: ProjectLifecycle = {
    ...lifecycle,
    state,
    updatedAt: now,
    history: [
      ...lifecycle.history,
      {
        state,
        at: now,
        detail,
      },
    ],
    lastError: state === "FAILED" ? detail : undefined,
  };

  return saveLifecycle(workspaceDirectory, updated);
}

function safePlanArtifactPath(
  workspaceDirectory: string,
  planId: string,
  relativePath: string,
): string {
  const directory = planDirectory(workspaceDirectory, planId);
  const target = resolve(directory, relativePath);
  const rel = relative(directory, target);

  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(
      "Project-plan artifact escapes its private plan directory: " +
        relativePath +
        ".",
    );
  }

  return target;
}

export async function calculateProjectPlanDigest(
  workspaceDirectory: string,
  planId?: string,
): Promise<string> {
  const current = planId
    ? undefined
    : await loadCurrentProjectPlan(workspaceDirectory);
  const selectedPlanId = planId ?? current?.planId;

  if (!selectedPlanId) {
    throw new Error("No project plan is available for approval.");
  }

  const manifest = await loadProjectPlanManifest(
    workspaceDirectory,
    selectedPlanId,
  );
  if (!manifest) {
    throw new Error(
      "Project plan " + selectedPlanId + " does not have a manifest.",
    );
  }

  const hash = createHash("sha256");
  const paths = [
    "plan-manifest.json",
    ...manifest.artifacts.map((artifact) => artifact.relativePath),
  ].sort();

  for (const relativePath of paths) {
    const path = safePlanArtifactPath(
      workspaceDirectory,
      selectedPlanId,
      relativePath,
    );
    const bytes = await readFile(path);
    hash.update(relativePath, "utf8");
    hash.update("\0", "utf8");
    hash.update(bytes);
    hash.update("\0", "utf8");
  }

  return hash.digest("hex");
}

export async function planApprovalStatus(
  workspaceDirectory: string,
): Promise<PlanApprovalStatus> {
  const current = await loadCurrentProjectPlan(workspaceDirectory);
  const approval = await loadProjectApproval(workspaceDirectory);
  const lifecycle = await loadProjectLifecycle(workspaceDirectory);

  if (!current) {
    return {
      approval,
      verified: false,
      reason: "No current project plan exists.",
      lifecycle,
    };
  }

  const currentDigest = await calculateProjectPlanDigest(
    workspaceDirectory,
    current.planId,
  );

  if (!approval) {
    return {
      currentPlanId: current.planId,
      currentDigest,
      verified: false,
      reason: "The current plan has not been approved by the user.",
      lifecycle,
    };
  }

  if (approval.planId !== current.planId) {
    return {
      currentPlanId: current.planId,
      approval,
      currentDigest,
      verified: false,
      reason:
        "The approval belongs to plan " +
        approval.planId +
        ", not the current plan " +
        current.planId +
        ".",
      lifecycle,
    };
  }

  if (approval.planDigest !== currentDigest) {
    return {
      currentPlanId: current.planId,
      approval,
      currentDigest,
      verified: false,
      reason:
        "The approved plan bytes changed after approval; re-approval is required.",
      lifecycle,
    };
  }

  return {
    currentPlanId: current.planId,
    approval,
    currentDigest,
    verified: true,
    lifecycle,
  };
}

export async function approveCurrentProjectPlan(
  workspaceDirectory: string,
): Promise<ProjectApproval> {
  const current = await loadCurrentProjectPlan(workspaceDirectory);
  if (!current) {
    throw new Error(
      "Generate a project plan before approving initialization.",
    );
  }

  const manifest = await loadProjectPlanManifest(
    workspaceDirectory,
    current.planId,
  );
  if (!manifest) {
    throw new Error("The current project plan manifest is missing.");
  }

  const digest = await calculateProjectPlanDigest(
    workspaceDirectory,
    current.planId,
  );
  const now = new Date().toISOString();
  const approval: ProjectApproval = {
    version: 1,
    planId: current.planId,
    planDigest: digest,
    approvedAt: now,
    approvedBy: "user",
    discoverySessionId: manifest.discoverySessionId,
  };

  await writeAtomic(
    projectApprovalPath(workspaceDirectory),
    JSON.stringify(approval, null, 2) + "\n",
  );
  await rm(projectChangeRequestPath(workspaceDirectory), {
    force: true,
  });

  let lifecycle = await lifecycleForPlan(
    workspaceDirectory,
    current.planId,
  );
  lifecycle = await transitionLifecycle(
    workspaceDirectory,
    lifecycle,
    "APPROVED",
    "Exact plan digest approved by the user.",
  );

  return approval;
}

export async function requestProjectPlanChanges(
  workspaceDirectory: string,
  text: string,
): Promise<PlanChangeRequest> {
  const current = await loadCurrentProjectPlan(workspaceDirectory);
  if (!current) {
    throw new Error("No current project plan exists.");
  }

  const note = text.trim();
  if (!note) {
    throw new Error("A non-empty plan change request is required.");
  }

  const request: PlanChangeRequest = {
    version: 1,
    planId: current.planId,
    requestedAt: new Date().toISOString(),
    requestedBy: "user",
    text: note,
  };

  await writeAtomic(
    projectChangeRequestPath(workspaceDirectory),
    JSON.stringify(request, null, 2) + "\n",
  );
  await rm(projectApprovalPath(workspaceDirectory), {
    force: true,
  });

  let lifecycle = await lifecycleForPlan(
    workspaceDirectory,
    current.planId,
  );
  lifecycle = await transitionLifecycle(
    workspaceDirectory,
    lifecycle,
    "PLAN_REVIEW",
    "User requested plan changes.",
  );

  return request;
}

async function assertGreenfieldRepository(root: string): Promise<void> {
  const entries = await readdir(root, {
    withFileTypes: true,
  });
  const unexpected = entries
    .map((entry) => entry.name)
    .filter((name) => !GREENFIELD_ALLOWED.has(name));

  if (unexpected.length > 0) {
    throw new Error(
      "Project initialization currently requires a greenfield repository. " +
        "Unexpected existing paths: " +
        unexpected.join(", ") +
        ".",
    );
  }
}

function scaffoldPaths(session: DiscoverySession): string[] {
  const shape =
    session.answers.application_shape?.value ?? "fullstack_web";

  if (shape === "fullstack_web") {
    return [
      "apps/web/src/.gitkeep",
      "apps/api/src/.gitkeep",
      "packages/domain/src/.gitkeep",
      "packages/contracts/src/.gitkeep",
    ];
  }

  if (shape === "api_backend") {
    return [
      "apps/api/src/.gitkeep",
      "packages/domain/src/.gitkeep",
      "packages/contracts/src/.gitkeep",
    ];
  }

  if (shape === "frontend_only") {
    return [
      "apps/web/src/.gitkeep",
      "packages/contracts/src/.gitkeep",
    ];
  }

  if (shape === "desktop_app") {
    return [
      "apps/desktop/src/.gitkeep",
      "packages/domain/src/.gitkeep",
      "packages/contracts/src/.gitkeep",
    ];
  }

  return ["src/.gitkeep"];
}

function repositoryTargetForArtifact(
  root: string,
  relativePath: string,
): string {
  if (relativePath === "TASKS.md") {
    return resolve(root, "TASKS.md");
  }

  return resolve(root, "docs", "planning", relativePath);
}

function projectReadme(session: DiscoverySession): string {
  return (
    "# Project\n\n" +
    session.idea +
    "\n\n" +
    "## Engineering plan\n\n" +
    "The approved engineering plan is materialized under docs/planning/.\n\n" +
    "The executable work queue is TASKS.md.\n"
  );
}

function projectGitignore(): string {
  return [
    "node_modules/",
    "dist/",
    "build/",
    "coverage/",
    ".env",
    ".env.*",
    "!.env.example",
    ".DS_Store",
    "",
  ].join("\n");
}

async function materializationFiles(
  root: string,
  workspaceDirectory: string,
  manifest: ProjectPlanManifest,
  session: DiscoverySession,
  approval: ProjectApproval,
): Promise<Map<string, string>> {
  const files = new Map<string, string>();

  for (const artifact of manifest.artifacts) {
    const sourcePath = safePlanArtifactPath(
      workspaceDirectory,
      manifest.planId,
      artifact.relativePath,
    );
    files.set(
      repositoryTargetForArtifact(root, artifact.relativePath),
      await readFile(sourcePath, "utf8"),
    );
  }

  files.set(
    resolve(root, "docs", "planning", "plan-manifest.json"),
    await readFile(
      safePlanArtifactPath(
        workspaceDirectory,
        manifest.planId,
        "plan-manifest.json",
      ),
      "utf8",
    ),
  );

  files.set(
    resolve(root, "docs", "planning", "APPROVED_PLAN.md"),
    [
      "# Approved Project Plan",
      "",
      "- Plan ID: " + approval.planId,
      "- SHA-256: " + approval.planDigest,
      "- Approved at: " + approval.approvedAt,
      "- Approved by: user",
      "",
      "This record identifies the exact private plan bundle that was approved before project initialization.",
      "",
    ].join("\n"),
  );

  if (!(await exists(resolve(root, "README.md")))) {
    files.set(
      resolve(root, "README.md"),
      projectReadme(session),
    );
  }

  if (!(await exists(resolve(root, ".gitignore")))) {
    files.set(
      resolve(root, ".gitignore"),
      projectGitignore(),
    );
  }

  for (const relativePath of scaffoldPaths(session)) {
    files.set(resolve(root, relativePath), "");
  }

  return files;
}

async function preflightTargets(
  files: Map<string, string>,
): Promise<void> {
  const collisions: string[] = [];

  for (const path of files.keys()) {
    if (await exists(path)) collisions.push(path);
  }

  if (collisions.length > 0) {
    throw new Error(
      "Project initialization refuses to overwrite existing files: " +
        collisions.join(", ") +
        ".",
    );
  }
}

async function rollbackCreatedFiles(
  root: string,
  createdFiles: readonly string[],
): Promise<void> {
  for (const path of [...createdFiles].reverse()) {
    await rm(path, { force: true });
  }

  for (const directory of ["apps", "packages", "src", "docs"]) {
    await rm(resolve(root, directory), {
      recursive: true,
      force: true,
    });
  }
}

async function verifyMaterializedPlan(
  root: string,
  workspaceDirectory: string,
  manifest: ProjectPlanManifest,
): Promise<void> {
  for (const artifact of manifest.artifacts) {
    const sourcePath = safePlanArtifactPath(
      workspaceDirectory,
      manifest.planId,
      artifact.relativePath,
    );
    const targetPath = repositoryTargetForArtifact(
      root,
      artifact.relativePath,
    );

    const [expected, actual] = await Promise.all([
      readFile(sourcePath),
      readFile(targetPath),
    ]);

    if (!expected.equals(actual)) {
      throw new Error(
        "Materialized plan artifact does not match approved source: " +
          artifact.relativePath +
          ".",
      );
    }
  }
}

async function ensureRequiredBootstrapTools(
  root: string,
  config: AgentConfig,
): Promise<BootstrapReport> {
  let report = await inspectBootstrap(root, config);
  const installableRequired = report.requirements
    .filter(
      (item) =>
        item.level === "required" &&
        !item.installed &&
        item.installerAvailable,
    )
    .map((item) => item.id);

  if (installableRequired.length > 0) {
    report = (
      await remediateBootstrap(
        root,
        config,
        installableRequired,
        { approved: true },
      )
    ).report;
  }

  const missing = report.requirements.filter(
    (item) => item.level === "required" && !item.installed,
  );

  if (missing.length > 0) {
    throw new Error(
      "Foundation validation is missing required tools: " +
        missing.map((item) => item.name).join(", ") +
        ".",
    );
  }

  return report;
}

export async function initializeApprovedProject(
  root: string,
  workspaceDirectory: string,
  config: AgentConfig,
): Promise<ProjectInitializationResult> {
  const status = await planApprovalStatus(workspaceDirectory);

  if (
    !status.verified ||
    !status.approval ||
    !status.currentPlanId ||
    !status.currentDigest
  ) {
    throw new Error(
      "Project initialization requires an exact verified human approval. " +
        (status.reason ?? "Approval is invalid."),
    );
  }

  const manifest = await loadProjectPlanManifest(
    workspaceDirectory,
    status.currentPlanId,
  );
  if (!manifest) {
    throw new Error("The approved project plan manifest is missing.");
  }

  const session = await loadDiscoverySession(workspaceDirectory);
  if (!session) {
    throw new Error("The discovery session used by the plan is missing.");
  }

  if (
    session.sessionId !== manifest.discoverySessionId ||
    session.sessionId !== status.approval.discoverySessionId
  ) {
    throw new Error(
      "Discovery, plan and approval identity do not match.",
    );
  }

  await assertGreenfieldRepository(root);

  let lifecycle = await lifecycleForPlan(
    workspaceDirectory,
    manifest.planId,
  );
  lifecycle = await transitionLifecycle(
    workspaceDirectory,
    lifecycle,
    "PROJECT_INITIALIZING",
  );

  const files = await materializationFiles(
    root,
    workspaceDirectory,
    manifest,
    session,
    status.approval,
  );
  await preflightTargets(files);

  const createdFiles: string[] = [];

  try {
    for (const [path, content] of files) {
      await writeAtomic(path, content);
      createdFiles.push(path);
    }

    lifecycle = await transitionLifecycle(
      workspaceDirectory,
      lifecycle,
      "FOUNDATION_VALIDATION",
    );

    await verifyMaterializedPlan(
      root,
      workspaceDirectory,
      manifest,
    );

    const bootstrap = await ensureRequiredBootstrapTools(
      root,
      config,
    );

    const provider = await createMarkdownTaskProvider(
      root,
      config,
      "TASKS.md",
    );
    const nextTask = await provider.getNextTask();

    if (!nextTask) {
      throw new Error(
        "The approved task graph has no unblocked Todo task after materialization.",
      );
    }

    const store = new WorkflowStateStore(root, config);
    const selected = await selectWorkflowTask(
      store,
      provider,
      nextTask.key,
    );

    lifecycle = await transitionLifecycle(
      workspaceDirectory,
      lifecycle,
      "READY_FOR_IMPLEMENTATION",
      "Foundation validated; selected first unblocked task " +
        nextTask.key +
        ".",
    );

    return {
      planId: manifest.planId,
      planDigest: status.approval.planDigest,
      lifecycle,
      materializedFiles: [
        ...manifest.artifacts.map((artifact) =>
          artifact.relativePath === "TASKS.md"
            ? "TASKS.md"
            : "docs/planning/" + artifact.relativePath,
        ),
        "docs/planning/plan-manifest.json",
        "docs/planning/APPROVED_PLAN.md",
      ],
      scaffoldFiles: scaffoldPaths(session),
      bootstrap,
      nextTaskKey: nextTask.key,
      workflow: selected.workflow,
    };
  } catch (error) {
    await rollbackCreatedFiles(root, createdFiles);

    await transitionLifecycle(
      workspaceDirectory,
      lifecycle,
      "FAILED",
      error instanceof Error ? error.message : String(error),
    );

    throw error;
  }
}
