import { spawnSync } from "node:child_process";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import * as vscode from "vscode";
import { runCodingAgent, type CodingAgentEvent } from "@llmatic/agent-orchestrator";
import {
  inspectBootstrap,
  remediateBootstrap,
  type BootstrapReport,
} from "@llmatic/bootstrap-manager";
import { loadAgentConfig, WorkflowStateStore } from "@llmatic/core";
import { KiloGatewayClient } from "@llmatic/gateway-client";
import {
  compareSemver,
  parseReleaseManifest,
  type ReleaseManifest,
} from "@llmatic/release-metadata";
import {
  runCodeReview,
  runReviewFixLoop,
  type CodeReviewReport,
  type ReviewLoopEvent,
} from "@llmatic/review-engine";
import {
  ensureGlobalKiloMcpServer,
  isGlobalKiloLlmaticServerHealthy,
  readGlobalKiloLlmaticServer,
} from "@llmatic/kilo-connector";
import {
  installRuntimeBundle,
  inspectInstalledRuntime,
  readRuntimeManifest,
  type RuntimeInstallResult,
} from "@llmatic/runtime-installer";
import {
  evaluateSetupHealth,
  type SetupHealth,
  type SetupHealthIssue,
} from "@llmatic/setup-health";
import { stageVerifiedVsix } from "@llmatic/update-installer";
import { ensureManagedWorkspace, type ManagedWorkspace } from "@llmatic/workspace-manager";
import { LlmaticStatusProvider } from "./status-view.js";

const KILO_EXTENSION_ID = "kilocode.kilo-code";
const KILO_GATEWAY_SECRET = "llmatic.kiloGatewayApiKey";
const AUTO_FREE_WARNING_ACCEPTED = "llmatic.autoFreeDataWarningAccepted";
const ONBOARDING_VERSION = 1;

interface ExtensionState {
  activeWorkspace?: ManagedWorkspace;
  runtime?: RuntimeInstallResult;
  bootstrap?: BootstrapReport;
  health?: SetupHealth;
  kiloConnected: boolean;
  kiloReloadRecommended: boolean;
  lastError?: string;
}

interface DoctorCheck {
  name: string;
  status: "PASS" | "WARN" | "FAIL";
  detail: string;
}

interface KiloConnectionResult {
  connected: boolean;
  changed: boolean;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function configuration() {
  return vscode.workspace.getConfiguration("llmatic");
}

function firstWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
  return vscode.workspace.workspaceFolders?.[0];
}

function runtimeOverridePath(): string | undefined {
  const override = configuration().get<string>("runtimeMcpPath", "").trim();
  return override || undefined;
}

function bundledMcpServerPath(context: vscode.ExtensionContext): string {
  return context.asAbsolutePath("dist/runtime/mcp-server.mjs");
}

function bundledRuntimeManifestPath(context: vscode.ExtensionContext): string {
  return context.asAbsolutePath("dist/runtime/manifest.json");
}

async function ensureExtensionRuntime(
  context: vscode.ExtensionContext,
): Promise<RuntimeInstallResult> {
  const override = runtimeOverridePath();

  if (override) {
    const serverPath = resolve(override);
    if (!(await exists(serverPath))) {
      throw new Error("Configured llmatic.runtimeMcpPath does not exist: " + serverPath);
    }

    return {
      runtimeVersion: "override",
      sha256: "override",
      serverPath,
      manifestPath: "",
      installDirectory: resolve(serverPath, ".."),
      changed: false,
      healthy: true,
      source: "override",
    };
  }

  return installRuntimeBundle({
    bundlePath: bundledMcpServerPath(context),
    manifestPath: bundledRuntimeManifestPath(context),
    runtimeHome: context.globalStorageUri.fsPath,
  });
}

async function inspectExtensionRuntime(
  context: vscode.ExtensionContext,
): Promise<RuntimeInstallResult> {
  const override = runtimeOverridePath();
  if (override) return ensureExtensionRuntime(context);

  const manifest = await readRuntimeManifest(bundledRuntimeManifestPath(context));
  return inspectInstalledRuntime(context.globalStorageUri.fsPath, manifest);
}

async function attachWorkspace(
  context: vscode.ExtensionContext,
  folder: vscode.WorkspaceFolder,
): Promise<ManagedWorkspace> {
  const managed = await ensureManagedWorkspace(folder.uri.fsPath, context.globalStorageUri.fsPath);

  await context.workspaceState.update("llmatic.workspaceId", managed.id);
  await context.workspaceState.update("llmatic.workspaceRoot", managed.root);
  return managed;
}

async function connectKilo(context: vscode.ExtensionContext): Promise<KiloConnectionResult> {
  const kilo = vscode.extensions.getExtension(KILO_EXTENSION_ID);
  if (!kilo) return { connected: false, changed: false };

  const runtime = await ensureExtensionRuntime(context);
  const nodeCommand = configuration().get<string>("nodeCommand", "node").trim() || "node";

  const registration = await ensureGlobalKiloMcpServer({
    homeDirectory: homedir(),
    serverPath: runtime.serverPath,
    llmaticHome: context.globalStorageUri.fsPath,
    nodeCommand,
  });

  return { connected: true, changed: registration.changed };
}

function issueDetail(issue: SetupHealthIssue): string {
  return issue.detail ? issue.label + ": " + issue.detail : issue.label;
}

async function evaluateExtensionHealth(
  context: vscode.ExtensionContext,
  state: ExtensionState,
): Promise<SetupHealth> {
  const folder = firstWorkspaceFolder();
  const runtime = state.runtime ?? (await inspectExtensionRuntime(context));
  const kiloInstalled = Boolean(vscode.extensions.getExtension(KILO_EXTENSION_ID));
  const nodeCommand = configuration().get<string>("nodeCommand", "node").trim() || "node";
  const autoConnectKilo = configuration().get<boolean>("autoConnectKilo", true);

  let bootstrap = state.bootstrap;
  if (folder && state.activeWorkspace) {
    bootstrap = await inspectBootstrap(state.activeWorkspace.root, state.activeWorkspace.config);
    state.bootstrap = bootstrap;
  }

  const server = kiloInstalled ? await readGlobalKiloLlmaticServer(homedir()) : undefined;
  const kiloMcpHealthy =
    kiloInstalled &&
    isGlobalKiloLlmaticServerHealthy(server, {
      serverPath: runtime.serverPath,
      llmaticHome: context.globalStorageUri.fsPath,
      nodeCommand,
    });

  const health = evaluateSetupHealth({
    workspaceOpen: Boolean(folder),
    workspaceAttached: Boolean(state.activeWorkspace),
    managedConfigPresent: Boolean(
      state.activeWorkspace && (await exists(state.activeWorkspace.configPath)),
    ),
    runtimeHealthy: runtime.healthy,
    missingRequiredTools:
      bootstrap?.requirements
        .filter((item) => item.level === "required" && !item.installed)
        .map((item) => item.name) ?? [],
    kiloRequired: autoConnectKilo,
    kiloInstalled,
    kiloMcpHealthy,
  });

  state.health = health;
  return health;
}

function writeHealthReport(output: vscode.OutputChannel, health: SetupHealth): void {
  output.appendLine("Health: " + health.status);
  if (health.issues.length === 0) {
    output.appendLine("[PASS] Runtime is ready.");
    return;
  }

  for (const issue of health.issues) {
    output.appendLine(
      "[" + (issue.kind === "repair" ? "REPAIR" : "SETUP") + "] " + issueDetail(issue),
    );
  }
}

function updateStatusBar(statusBar: vscode.StatusBarItem, state: ExtensionState): void {
  const health = state.health;
  statusBar.command = health?.status === "READY" ? "llmatic.showStatus" : "llmatic.getReady";

  if (state.lastError) {
    statusBar.text = "$(error) LLMatic: NEEDS REPAIR";
    statusBar.tooltip = state.lastError;
    statusBar.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
  } else if (!health || health.status === "NEEDS_SETUP") {
    statusBar.text = "$(tools) LLMatic: NEEDS SETUP";
    statusBar.tooltip = health?.issues.map(issueDetail).join("\n") ?? "Run LLMatic: Get Ready.";
    statusBar.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
  } else if (health.status === "NEEDS_REPAIR") {
    statusBar.text = "$(wrench) LLMatic: NEEDS REPAIR";
    statusBar.tooltip = health.issues.map(issueDetail).join("\n");
    statusBar.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
  } else {
    statusBar.text = "$(check) LLMatic: READY";
    statusBar.tooltip = "Workspace, runtime, required tools, and configured Kilo MCP are ready.";
    statusBar.backgroundColor = undefined;
  }

  statusBar.show();
}

async function refresh(
  context: vscode.ExtensionContext,
  statusBar: vscode.StatusBarItem,
  state: ExtensionState,
): Promise<void> {
  state.lastError = undefined;

  try {
    const folder = firstWorkspaceFolder();
    const autoAttach = configuration().get<boolean>("autoAttachWorkspace", true);

    if (folder && autoAttach) {
      state.activeWorkspace = await attachWorkspace(context, folder);
    } else if (!folder) {
      state.activeWorkspace = undefined;
    }

    state.runtime = await ensureExtensionRuntime(context);

    const autoConnect = configuration().get<boolean>("autoConnectKilo", true);
    if (autoConnect) {
      const kilo = await connectKilo(context);
      state.kiloConnected = kilo.connected;
      state.kiloReloadRecommended = kilo.changed;
    } else {
      state.kiloConnected = false;
      state.kiloReloadRecommended = false;
    }

    await evaluateExtensionHealth(context, state);
  } catch (error) {
    state.lastError = error instanceof Error ? error.message : String(error);
  }

  updateStatusBar(statusBar, state);
}

function nodeVersion(nodeCommand: string): string | undefined {
  const result = spawnSync(nodeCommand, ["--version"], {
    encoding: "utf8",
    shell: false,
  });

  if (result.status !== 0) return undefined;
  return (result.stdout || result.stderr).trim().split(/\r?\n/)[0];
}

async function runDoctor(
  context: vscode.ExtensionContext,
  state: ExtensionState,
): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const folder = firstWorkspaceFolder();
  const runtime = await inspectExtensionRuntime(context);
  const serverPath = runtime.serverPath;
  const nodeCommand = configuration().get<string>("nodeCommand", "node").trim() || "node";
  const version = nodeVersion(nodeCommand);

  checks.push({
    name: "Workspace",
    status: folder && state.activeWorkspace ? "PASS" : "FAIL",
    detail:
      folder && state.activeWorkspace
        ? state.activeWorkspace.root
        : "No attached workspace is available.",
  });

  checks.push({
    name: "Managed config",
    status:
      state.activeWorkspace && (await exists(state.activeWorkspace.configPath)) ? "PASS" : "FAIL",
    detail: state.activeWorkspace?.configPath ?? "Managed workspace config is unavailable.",
  });

  checks.push({
    name: "Runtime integrity",
    status: runtime.healthy ? "PASS" : "FAIL",
    detail:
      runtime.source === "override"
        ? "Custom runtime override: " + runtime.serverPath
        : runtime.runtimeVersion + " / " + runtime.sha256.slice(0, 12) + " / " + runtime.serverPath,
  });

  let nodeStatus: DoctorCheck["status"] = "FAIL";
  if (version) {
    const major = Number(version.replace(/^v/, "").split(".")[0]);
    nodeStatus = Number.isFinite(major) && major >= 20 ? "PASS" : "FAIL";
  }
  checks.push({
    name: "Node.js",
    status: nodeStatus,
    detail: version ? nodeCommand + " " + version : nodeCommand + " is not available on PATH.",
  });

  const kiloInstalled = Boolean(vscode.extensions.getExtension(KILO_EXTENSION_ID));
  checks.push({
    name: "Kilo Code",
    status: kiloInstalled ? "PASS" : "WARN",
    detail: kiloInstalled ? KILO_EXTENSION_ID : "Kilo Code is not installed.",
  });

  const server = kiloInstalled ? await readGlobalKiloLlmaticServer(homedir()) : undefined;
  const kiloHealthy =
    kiloInstalled &&
    isGlobalKiloLlmaticServerHealthy(server, {
      serverPath,
      llmaticHome: context.globalStorageUri.fsPath,
      nodeCommand,
    });

  checks.push({
    name: "Kilo MCP",
    status: kiloHealthy ? "PASS" : kiloInstalled ? "FAIL" : "WARN",
    detail: kiloHealthy
      ? "Global LLMatic MCP registration matches this extension."
      : "Global LLMatic MCP registration is missing or stale.",
  });

  const hasGatewayKey = Boolean(await context.secrets.get(KILO_GATEWAY_SECRET));
  checks.push({
    name: "Kilo Gateway key",
    status: hasGatewayKey ? "PASS" : "WARN",
    detail: hasGatewayKey
      ? "Stored in VS Code SecretStorage."
      : "Not configured; only needed for future direct Gateway orchestration.",
  });

  return checks;
}

async function repairRuntime(
  context: vscode.ExtensionContext,
  state: ExtensionState,
  statusBar: vscode.StatusBarItem,
  output: vscode.OutputChannel,
): Promise<void> {
  const override = runtimeOverridePath();
  if (override) {
    throw new Error(
      "Runtime repair is disabled while llmatic.runtimeMcpPath override is configured.",
    );
  }

  const runtime = await installRuntimeBundle({
    bundlePath: bundledMcpServerPath(context),
    manifestPath: bundledRuntimeManifestPath(context),
    runtimeHome: context.globalStorageUri.fsPath,
    force: true,
  });

  state.runtime = runtime;

  const kiloInstalled = Boolean(vscode.extensions.getExtension(KILO_EXTENSION_ID));
  let kiloChanged = false;

  if (kiloInstalled) {
    const kilo = await connectKilo(context);
    state.kiloConnected = kilo.connected;
    state.kiloReloadRecommended = kilo.changed;
    kiloChanged = kilo.changed;
  }

  state.lastError = undefined;
  updateStatusBar(statusBar, state);

  output.clear();
  output.appendLine("LLMatic Runtime Repair");
  output.appendLine("");
  output.appendLine("[PASS] Runtime: " + runtime.runtimeVersion);
  output.appendLine("[PASS] SHA-256: " + runtime.sha256);
  output.appendLine("[PASS] Installed: " + runtime.serverPath);
  output.appendLine(
    kiloInstalled
      ? "[PASS] Kilo MCP: " + (kiloChanged ? "registration repaired" : "already healthy")
      : "[WARN] Kilo Code: not installed",
  );
  output.show(true);

  const action = kiloChanged
    ? await vscode.window.showInformationMessage(
        "LLMatic runtime repaired and Kilo MCP updated.",
        "Reload Window",
      )
    : await vscode.window.showInformationMessage("LLMatic runtime is healthy.");

  if (action === "Reload Window") {
    await vscode.commands.executeCommand("workbench.action.reloadWindow");
  }
}

interface GithubReleaseAsset {
  name: string;
  browser_download_url: string;
}

interface GithubReleaseResponse {
  html_url: string;
  tag_name: string;
  assets: GithubReleaseAsset[];
}

interface LatestRelease {
  manifest: ReleaseManifest;
  releaseUrl: string;
  vsixUrl: string;
}

async function fetchLatestReleaseManifest(): Promise<LatestRelease> {
  const repository =
    configuration().get<string>("releaseRepository", "pikkst/llmatic-agent-runtime").trim() ||
    "pikkst/llmatic-agent-runtime";
  const releaseResponse = await fetch(
    "https://api.github.com/repos/" + repository + "/releases/latest",
    {
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );

  if (!releaseResponse.ok) {
    throw new Error(
      "GitHub latest-release request failed with " +
        releaseResponse.status +
        " " +
        releaseResponse.statusText,
    );
  }

  const release = (await releaseResponse.json()) as GithubReleaseResponse;
  const manifestAsset = release.assets.find((asset) => asset.name === "release-manifest.json");
  if (!manifestAsset) {
    throw new Error("Latest LLMatic release does not contain release-manifest.json.");
  }

  const manifestResponse = await fetch(manifestAsset.browser_download_url, {
    headers: { Accept: "application/json" },
  });

  if (!manifestResponse.ok) {
    throw new Error(
      "Release manifest download failed with " +
        manifestResponse.status +
        " " +
        manifestResponse.statusText,
    );
  }

  const manifest = parseReleaseManifest(await manifestResponse.json());
  if (manifest.repository !== repository) {
    throw new Error(
      "Release manifest repository " +
        manifest.repository +
        " does not match configured repository " +
        repository +
        ".",
    );
  }
  if (manifest.tag !== release.tag_name) {
    throw new Error(
      "Release tag " + release.tag_name + " does not match manifest tag " + manifest.tag + ".",
    );
  }

  const vsixAsset = release.assets.find((asset) => asset.name === manifest.vsix.file);
  if (!vsixAsset) {
    throw new Error("Latest release does not contain the VSIX declared by its manifest.");
  }

  return {
    manifest,
    releaseUrl: release.html_url,
    vsixUrl: vsixAsset.browser_download_url,
  };
}

async function installLatestUpdate(
  context: vscode.ExtensionContext,
  latest?: LatestRelease,
): Promise<void> {
  const currentVersion = String(context.extension.packageJSON.version ?? "0.0.0");
  const release = latest ?? (await fetchLatestReleaseManifest());

  if (compareSemver(release.manifest.version, currentVersion) <= 0) {
    await vscode.window.showInformationMessage("LLMatic " + currentVersion + " is up to date.");
    return;
  }

  const confirm = await vscode.window.showWarningMessage(
    "Install verified LLMatic " +
      release.manifest.version +
      " over installed " +
      currentVersion +
      "? The VSIX SHA-256 will be verified before VS Code installs it.",
    { modal: true },
    "Download & Install",
  );
  if (confirm !== "Download & Install") return;

  const response = await fetch(release.vsixUrl, {
    headers: { Accept: "application/octet-stream" },
  });
  if (!response.ok) {
    throw new Error("VSIX download failed with " + response.status + " " + response.statusText);
  }

  const staged = await stageVerifiedVsix({
    bytes: new Uint8Array(await response.arrayBuffer()),
    expected: release.manifest.vsix,
    updateHome: context.globalStorageUri.fsPath,
    version: release.manifest.version,
  });

  await vscode.commands.executeCommand(
    "workbench.extensions.installExtension",
    vscode.Uri.file(staged.path),
  );

  const action = await vscode.window.showInformationMessage(
    "LLMatic " + release.manifest.version + " installed. Reload VS Code to activate it.",
    "Reload Window",
  );
  if (action === "Reload Window") {
    await vscode.commands.executeCommand("workbench.action.reloadWindow");
  }
}

async function checkForUpdates(context: vscode.ExtensionContext): Promise<void> {
  const currentVersion = String(context.extension.packageJSON.version ?? "0.0.0");
  const latest = await fetchLatestReleaseManifest();
  const comparison = compareSemver(latest.manifest.version, currentVersion);

  if (comparison <= 0) {
    await vscode.window.showInformationMessage("LLMatic " + currentVersion + " is up to date.");
    return;
  }

  const action = await vscode.window.showInformationMessage(
    "LLMatic " + latest.manifest.version + " is available (installed: " + currentVersion + ").",
    "Install Update",
    "Open Release",
  );

  if (action === "Install Update") {
    await installLatestUpdate(context, latest);
  } else if (action === "Open Release") {
    await vscode.env.openExternal(vscode.Uri.parse(latest.releaseUrl));
  }
}

async function showDoctor(
  context: vscode.ExtensionContext,
  state: ExtensionState,
  output: vscode.OutputChannel,
): Promise<void> {
  const checks = await runDoctor(context, state);
  output.clear();
  output.appendLine("LLMatic Agent Runtime Doctor");
  output.appendLine("");

  for (const check of checks) {
    output.appendLine("[" + check.status + "] " + check.name + ": " + check.detail);
  }

  const failures = checks.filter((check) => check.status === "FAIL").length;
  const warnings = checks.filter((check) => check.status === "WARN").length;
  output.appendLine("");
  output.appendLine(
    failures === 0
      ? "READY" + (warnings ? " (" + warnings + " warning(s))" : "")
      : "NOT READY (" + failures + " failure(s))",
  );
  output.show(true);

  if (failures === 0) {
    await vscode.window.showInformationMessage("LLMatic Doctor: READY");
  } else {
    await vscode.window.showWarningMessage(
      "LLMatic Doctor found " + failures + " blocking issue(s). See the LLMatic output channel.",
    );
  }
}

function formatAgentEvent(event: CodingAgentEvent): string {
  if (event.type === "model") return "[MODEL] step " + event.step;
  if (event.type === "tool-start") return "[TOOL] " + event.name;
  if (event.type === "tool-result") {
    return "[" + (event.success ? "PASS" : "FAIL") + "] " + event.name;
  }
  return "[INFO] " + event.message;
}

async function confirmAutoFreeDataHandling(
  context: vscode.ExtensionContext,
  model: string,
): Promise<boolean> {
  if (model !== "kilo-auto/free") return true;

  const accepted = context.globalState.get<boolean>(AUTO_FREE_WARNING_ACCEPTED, false);
  if (accepted) return true;

  const selection = await vscode.window.showWarningMessage(
    "Auto Free may route repository snippets to third-party inference providers that can log prompts/outputs. LLMatic blocks common secret files, but do not use Auto Free for confidential source code.",
    { modal: true },
    "Continue with Auto Free",
  );

  if (selection !== "Continue with Auto Free") return false;
  await context.globalState.update(AUTO_FREE_WARNING_ACCEPTED, true);
  return true;
}

function printReviewReport(output: vscode.OutputChannel, report: CodeReviewReport): void {
  output.appendLine("Review summary: " + report.summary);
  output.appendLine(
    "Findings: " +
      report.findings.length +
      " (" +
      report.blockingCount +
      " blocking, " +
      report.nonBlockingCount +
      " non-blocking)",
  );
  output.appendLine("");

  for (const finding of report.findings) {
    const location = finding.line ? finding.path + ":" + finding.line : finding.path;
    output.appendLine(
      "[" +
        (finding.severity === "blocking" ? "BLOCKING" : "NON-BLOCKING") +
        "] " +
        finding.title +
        " — " +
        location,
    );
    output.appendLine("  " + finding.evidence);
    output.appendLine("  Fix: " + finding.recommendation);
  }
}

function formatReviewLoopEvent(event: ReviewLoopEvent): string {
  if (event.type === "review-start") return "[REVIEW] round " + event.round;
  if (event.type === "review-complete") {
    return "[REVIEW] " + event.blockingCount + " blocking finding(s)";
  }
  if (event.type === "fix-start") return "[FIX] round " + event.round;
  if (event.type === "validation") {
    return "[VALIDATION] " + (event.success ? "PASS" : "FAIL");
  }
  return "[INFO] " + event.message;
}

async function runGatewayReview(
  context: vscode.ExtensionContext,
  state: ExtensionState,
  output: vscode.OutputChannel,
  fixLoop: boolean,
): Promise<void> {
  const folder = firstWorkspaceFolder();
  if (!folder) {
    throw new Error("Open a repository workspace before running review.");
  }

  if (!state.activeWorkspace) {
    state.activeWorkspace = await attachWorkspace(context, folder);
  }

  const apiKey = await context.secrets.get(KILO_GATEWAY_SECRET);
  if (!apiKey) {
    throw new Error(
      "Kilo Gateway API key is not configured. Run 'LLMatic: Set Kilo Gateway API Key' first.",
    );
  }

  const model =
    configuration().get<string>("agentModel", "kilo-auto/free").trim() || "kilo-auto/free";
  if (!(await confirmAutoFreeDataHandling(context, model))) return;

  const root = folder.uri.fsPath;
  const config = await loadAgentConfig(root, {
    LLMATIC_HOME: context.globalStorageUri.fsPath,
  });
  const store = new WorkflowStateStore(root, config);
  const gateway = new KiloGatewayClient({ apiKey });

  output.clear();
  output.appendLine(fixLoop ? "LLMatic Review / Fix Loop" : "LLMatic Code Review");
  output.appendLine("Model: " + model);
  output.appendLine("Workspace: " + root);
  output.appendLine("");

  if (fixLoop) {
    const result = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "LLMatic review/fix loop is running",
        cancellable: false,
      },
      async (progress) =>
        runReviewFixLoop({
          root,
          config,
          store,
          gateway,
          model,
          maxSteps: configuration().get<number>("agentMaxSteps", 20),
          maxReviewRounds: config.workflow.maxFixAttempts,
          onEvent: (event) => {
            const line = formatReviewLoopEvent(event);
            output.appendLine(line);
            progress.report({ message: line });
          },
        }),
    );

    output.appendLine("");
    printReviewReport(output, result.review);
    output.appendLine("");
    output.appendLine("Review rounds: " + result.reviewRounds);
    output.appendLine("Fix rounds: " + result.fixRounds);
    output.show(true);

    await vscode.window.showInformationMessage(
      "LLMatic review/fix loop completed with " +
        result.review.blockingCount +
        " blocking finding(s).",
    );
    return;
  }

  const report = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "LLMatic code review is running",
      cancellable: false,
    },
    () =>
      runCodeReview({
        root,
        config,
        store,
        gateway,
        model,
      }),
  );

  printReviewReport(output, report);
  output.show(true);

  await vscode.window.showInformationMessage(
    "LLMatic review: " +
      report.blockingCount +
      " blocking / " +
      report.nonBlockingCount +
      " non-blocking finding(s).",
  );
}

async function runGatewayAgent(
  context: vscode.ExtensionContext,
  state: ExtensionState,
  output: vscode.OutputChannel,
): Promise<void> {
  const folder = firstWorkspaceFolder();
  if (!folder) {
    throw new Error("Open a repository workspace before running the LLMatic agent.");
  }

  if (!state.activeWorkspace) {
    state.activeWorkspace = await attachWorkspace(context, folder);
  }

  const apiKey = await context.secrets.get(KILO_GATEWAY_SECRET);
  if (!apiKey) {
    throw new Error(
      "Kilo Gateway API key is not configured. Run 'LLMatic: Set Kilo Gateway API Key' first.",
    );
  }

  const model =
    configuration().get<string>("agentModel", "kilo-auto/free").trim() || "kilo-auto/free";
  if (!(await confirmAutoFreeDataHandling(context, model))) return;

  const instruction = await vscode.window.showInputBox({
    title: "LLMatic Gateway Agent",
    prompt: "Describe the implementation or fix you want the agent to perform in this repository.",
    ignoreFocusOut: true,
  });

  if (!instruction?.trim()) return;

  const maxSteps = configuration().get<number>("agentMaxSteps", 20);
  const root = folder.uri.fsPath;
  const runtimeConfig = await loadAgentConfig(root, {
    LLMATIC_HOME: context.globalStorageUri.fsPath,
  });
  const store = new WorkflowStateStore(root, runtimeConfig);
  const gateway = new KiloGatewayClient({ apiKey });

  output.clear();
  output.appendLine("LLMatic Gateway Agent");
  output.appendLine("Model: " + model);
  output.appendLine("Workspace: " + root);
  output.appendLine("");

  const result = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "LLMatic agent is working",
      cancellable: false,
    },
    async (progress) =>
      runCodingAgent({
        root,
        config: runtimeConfig,
        store,
        gateway,
        instruction: instruction.trim(),
        model,
        maxSteps,
        onEvent: (event) => {
          const line = formatAgentEvent(event);
          output.appendLine(line);
          progress.report({ message: line });
        },
      }),
  );

  output.appendLine("");
  output.appendLine("Final response:");
  output.appendLine(result.finalText);
  output.appendLine("");
  output.appendLine(
    "Usage: " +
      result.usage.promptTokens +
      " prompt / " +
      result.usage.completionTokens +
      " completion tokens",
  );
  output.show(true);

  await vscode.window.showInformationMessage(
    "LLMatic agent completed in " + result.steps + " step(s). See the LLMatic output channel.",
  );
}

function writeBootstrapReport(output: vscode.OutputChannel, report: BootstrapReport): void {
  output.clear();
  output.appendLine("LLMatic Workspace Bootstrap");
  output.appendLine("Repository: " + report.root);
  output.appendLine("Ready: " + (report.ready ? "yes" : "no"));
  output.appendLine("");

  for (const item of report.requirements) {
    const marker = item.installed ? "PASS" : item.level === "required" ? "FAIL" : "WARN";
    const installer = !item.installed && item.installerAvailable ? " [auto-install available]" : "";
    output.appendLine(
      "[" + marker + "] " + item.name + " (" + item.level + "): " + item.reason + installer,
    );
  }

  if (report.unsupportedPackageManager) {
    output.appendLine("");
    output.appendLine("[WARN] Package manager: " + report.unsupportedPackageManager);
  }
}

async function bootstrapWorkspace(
  context: vscode.ExtensionContext,
  state: ExtensionState,
  statusBar: vscode.StatusBarItem,
  output: vscode.OutputChannel,
): Promise<void> {
  const folder = firstWorkspaceFolder();
  if (!folder) {
    await vscode.window.showWarningMessage("Open a workspace before bootstrapping LLMatic.");
    return;
  }

  state.activeWorkspace = await attachWorkspace(context, folder);
  let report = await inspectBootstrap(state.activeWorkspace.root, state.activeWorkspace.config);
  writeBootstrapReport(output, report);
  output.show(true);

  const autoInstallable = report.requirements.filter(
    (item) => !item.installed && item.installerAvailable,
  );

  if (autoInstallable.length > 0) {
    const names = autoInstallable.map((item) => item.name).join(", ");
    const action = await vscode.window.showInformationMessage(
      "LLMatic can install registered missing tools: " + names + ".",
      { modal: true },
      "Install",
    );

    if (action === "Install") {
      const result = await remediateBootstrap(
        state.activeWorkspace.root,
        state.activeWorkspace.config,
        autoInstallable.map((item) => item.id),
        { approved: true },
      );

      report = result.report;
      writeBootstrapReport(output, report);
      output.appendLine("");

      for (const installation of result.installations) {
        output.appendLine(
          "[INSTALL] " +
            installation.tool.name +
            ": " +
            (installation.changed ? "installed" : "already available"),
        );
      }
    }
  }

  const kilo = await connectKilo(context);
  state.kiloConnected = kilo.connected;
  state.kiloReloadRecommended = kilo.changed;
  state.lastError = undefined;
  updateStatusBar(statusBar, state);

  const missingRequired = report.requirements.filter(
    (item) => item.level === "required" && !item.installed,
  );

  if (missingRequired.length > 0) {
    await vscode.window.showWarningMessage(
      "LLMatic bootstrap needs manual setup for: " +
        missingRequired.map((item) => item.name).join(", ") +
        ". See the LLMatic output channel.",
    );
    return;
  }

  if (kilo.changed) {
    const action = await vscode.window.showInformationMessage(
      "LLMatic workspace is ready. Kilo MCP configuration changed.",
      "Reload Window",
    );
    if (action === "Reload Window") {
      await vscode.commands.executeCommand("workbench.action.reloadWindow");
    }
  } else {
    await vscode.window.showInformationMessage("LLMatic workspace bootstrap is ready.");
  }
}

async function getReady(
  context: vscode.ExtensionContext,
  state: ExtensionState,
  statusBar: vscode.StatusBarItem,
  statusProvider: LlmaticStatusProvider,
  output: vscode.OutputChannel,
): Promise<void> {
  const folder = firstWorkspaceFolder();
  if (!folder) {
    await vscode.window.showWarningMessage(
      "Open a repository workspace before running LLMatic: Get Ready.",
    );
    return;
  }

  output.clear();
  output.appendLine("LLMatic Get Ready");
  output.appendLine("Repository: " + folder.uri.fsPath);
  output.appendLine("");

  state.activeWorkspace = await attachWorkspace(context, folder);
  output.appendLine("[PASS] Workspace attached outside the repository.");

  let runtime = await inspectExtensionRuntime(context);
  if (!runtime.healthy) {
    output.appendLine("[REPAIR] Runtime integrity failed; reinstalling bundled runtime.");
    runtime = await installRuntimeBundle({
      bundlePath: bundledMcpServerPath(context),
      manifestPath: bundledRuntimeManifestPath(context),
      runtimeHome: context.globalStorageUri.fsPath,
      force: true,
    });
  } else {
    output.appendLine("[PASS] Runtime integrity verified.");
  }
  state.runtime = runtime;

  let bootstrap = await inspectBootstrap(state.activeWorkspace.root, state.activeWorkspace.config);
  const installableRequired = bootstrap.requirements.filter(
    (item) => item.level === "required" && !item.installed && item.installerAvailable,
  );

  if (installableRequired.length > 0) {
    const action = await vscode.window.showInformationMessage(
      "LLMatic can install required registered tools: " +
        installableRequired.map((item) => item.name).join(", ") +
        ".",
      { modal: true },
      "Install Required Tools",
    );

    if (action === "Install Required Tools") {
      const remediation = await remediateBootstrap(
        state.activeWorkspace.root,
        state.activeWorkspace.config,
        installableRequired.map((item) => item.id),
        { approved: true },
      );
      bootstrap = remediation.report;
      for (const installation of remediation.installations) {
        output.appendLine(
          "[INSTALL] " +
            installation.tool.name +
            ": " +
            (installation.changed ? "installed" : "already available"),
        );
      }
    }
  }

  state.bootstrap = bootstrap;
  const missingRequired = bootstrap.requirements.filter(
    (item) => item.level === "required" && !item.installed,
  );
  for (const item of missingRequired) {
    output.appendLine("[SETUP] Required tool missing: " + item.name + " — " + item.reason);
  }

  const kiloInstalled = Boolean(vscode.extensions.getExtension(KILO_EXTENSION_ID));
  if (!kiloInstalled && configuration().get<boolean>("autoConnectKilo", true)) {
    output.appendLine("[SETUP] Kilo Code is not installed.");
    const action = await vscode.window.showInformationMessage(
      "Kilo Code is required by the current LLMatic auto-connect configuration.",
      "Open Kilo Code Extension",
    );
    if (action === "Open Kilo Code Extension") {
      await vscode.commands.executeCommand(
        "workbench.extensions.search",
        "@id:" + KILO_EXTENSION_ID,
      );
    }
  } else if (kiloInstalled) {
    const kilo = await connectKilo(context);
    state.kiloConnected = kilo.connected;
    state.kiloReloadRecommended = kilo.changed;
    output.appendLine(
      "[PASS] Kilo MCP: " + (kilo.changed ? "registration reconciled" : "already healthy"),
    );
  }

  const health = await evaluateExtensionHealth(context, state);
  output.appendLine("");
  writeHealthReport(output, health);
  output.show(true);
  updateStatusBar(statusBar, state);
  statusProvider.update(state.health);

  if (health.status === "READY") {
    await context.workspaceState.update("llmatic.onboardingVersion", ONBOARDING_VERSION);
    const action = state.kiloReloadRecommended
      ? await vscode.window.showInformationMessage(
          "LLMatic is READY. Kilo MCP changed and a window reload is recommended.",
          "Reload Window",
        )
      : await vscode.window.showInformationMessage("LLMatic is READY.");

    if (action === "Reload Window") {
      await vscode.commands.executeCommand("workbench.action.reloadWindow");
    }
    return;
  }

  await vscode.window.showWarningMessage(
    "LLMatic is " +
      health.status.replace("_", " ") +
      ". See the LLMatic output and Runtime Status view.",
  );
}

async function offerOnboarding(
  context: vscode.ExtensionContext,
  state: ExtensionState,
): Promise<void> {
  if (!firstWorkspaceFolder()) return;
  if (state.health?.status === "READY") return;

  const seen = context.workspaceState.get<number>("llmatic.onboardingVersion", 0);
  if (seen >= ONBOARDING_VERSION) return;

  await context.workspaceState.update("llmatic.onboardingVersion", ONBOARDING_VERSION);
  const action = await vscode.window.showInformationMessage(
    "LLMatic needs setup for this workspace. Get Ready can configure the external runtime without adding LLMatic files to the repository.",
    "Get Ready",
  );

  if (action === "Get Ready") {
    await vscode.commands.executeCommand("llmatic.getReady");
  }
}

async function showStatus(context: vscode.ExtensionContext, state: ExtensionState): Promise<void> {
  const kiloInstalled = Boolean(vscode.extensions.getExtension(KILO_EXTENSION_ID));
  const kiloServer = kiloInstalled ? await readGlobalKiloLlmaticServer(homedir()) : undefined;
  const hasGatewayKey = Boolean(await context.secrets.get(KILO_GATEWAY_SECRET));

  const health = state.health ?? (await evaluateExtensionHealth(context, state));
  const lines = [
    "Health: " + health.status,
    state.activeWorkspace ? "Workspace: " + state.activeWorkspace.root : "Workspace: not attached",
    state.activeWorkspace ? "Workspace data: " + state.activeWorkspace.directory : undefined,
    state.runtime
      ? "Runtime: " +
        (state.runtime.healthy ? state.runtime.runtimeVersion + " verified" : "needs repair")
      : "Runtime: unknown",
    "Kilo Code: " + (kiloInstalled ? "installed" : "not installed"),
    "Kilo MCP: " + (kiloServer ? "configured" : "not configured"),
    "Kilo Gateway key: " + (hasGatewayKey ? "stored securely" : "not stored"),
    state.kiloReloadRecommended ? "Kilo reload: recommended after config update" : undefined,
    state.lastError ? "Error: " + state.lastError : undefined,
  ].filter((line): line is string => Boolean(line));

  await vscode.window.showInformationMessage(lines.join("\n"), { modal: true });
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  await vscode.workspace.fs.createDirectory(context.globalStorageUri);

  const state: ExtensionState = {
    kiloConnected: false,
    kiloReloadRecommended: false,
  };

  const output = vscode.window.createOutputChannel("LLMatic");
  context.subscriptions.push(output);

  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  context.subscriptions.push(statusBar);

  const statusProvider = new LlmaticStatusProvider();
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("llmatic.status", statusProvider),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("llmatic.getReady", async () => {
      try {
        await getReady(context, state, statusBar, statusProvider, output);
      } catch (error) {
        state.lastError = error instanceof Error ? error.message : String(error);
        state.health = {
          status: "NEEDS_REPAIR",
          issues: [
            {
              code: "runtime_error",
              kind: "repair",
              label: "LLMatic runtime error",
              detail: state.lastError,
            },
          ],
        };
        updateStatusBar(statusBar, state);
        statusProvider.update(state.health);
        await vscode.window.showErrorMessage("LLMatic Get Ready: " + state.lastError);
      }
    }),
    vscode.commands.registerCommand("llmatic.attachWorkspace", async () => {
      const folder = firstWorkspaceFolder();
      if (!folder) {
        await vscode.window.showWarningMessage("Open a workspace before attaching LLMatic.");
        return;
      }

      try {
        state.activeWorkspace = await attachWorkspace(context, folder);
        state.lastError = undefined;
        updateStatusBar(statusBar, state);
        await vscode.window.showInformationMessage(
          "LLMatic attached without adding runtime state to the repository.",
        );
      } catch (error) {
        state.lastError = error instanceof Error ? error.message : String(error);
        updateStatusBar(statusBar, state);
        await vscode.window.showErrorMessage(state.lastError);
      }
    }),
    vscode.commands.registerCommand("llmatic.bootstrapWorkspace", async () => {
      try {
        await bootstrapWorkspace(context, state, statusBar, output);
      } catch (error) {
        state.lastError = error instanceof Error ? error.message : String(error);
        updateStatusBar(statusBar, state);
        output.appendLine("");
        output.appendLine("[FAIL] Bootstrap: " + state.lastError);
        output.show(true);
        await vscode.window.showErrorMessage(state.lastError);
      }
    }),
    vscode.commands.registerCommand("llmatic.connectKilo", async () => {
      if (!vscode.extensions.getExtension(KILO_EXTENSION_ID)) {
        const action = await vscode.window.showWarningMessage(
          "Kilo Code is not installed.",
          "Open Extensions",
        );
        if (action === "Open Extensions") {
          await vscode.commands.executeCommand(
            "workbench.extensions.search",
            "@id:kilocode.kilo-code",
          );
        }
        return;
      }

      try {
        const result = await connectKilo(context);
        state.kiloConnected = result.connected;
        state.kiloReloadRecommended = result.changed;
        state.lastError = undefined;
        updateStatusBar(statusBar, state);

        if (result.changed) {
          const action = await vscode.window.showInformationMessage(
            "LLMatic MCP was added or updated in Kilo global config.",
            "Reload Window",
          );
          if (action === "Reload Window") {
            await vscode.commands.executeCommand("workbench.action.reloadWindow");
          }
        } else {
          await vscode.window.showInformationMessage(
            "LLMatic MCP is already registered and healthy in Kilo global config.",
          );
        }
      } catch (error) {
        state.lastError = error instanceof Error ? error.message : String(error);
        updateStatusBar(statusBar, state);
        await vscode.window.showErrorMessage(state.lastError);
      }
    }),
    vscode.commands.registerCommand("llmatic.showStatus", async () => {
      await showStatus(context, state);
    }),
    vscode.commands.registerCommand("llmatic.checkForUpdates", async () => {
      try {
        await checkForUpdates(context);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await vscode.window.showErrorMessage("LLMatic update check: " + message);
      }
    }),
    vscode.commands.registerCommand("llmatic.installUpdate", async () => {
      try {
        await installLatestUpdate(context);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await vscode.window.showErrorMessage("LLMatic update install: " + message);
      }
    }),
    vscode.commands.registerCommand("llmatic.doctor", async () => {
      await showDoctor(context, state, output);
    }),
    vscode.commands.registerCommand("llmatic.repairRuntime", async () => {
      try {
        await repairRuntime(context, state, statusBar, output);
      } catch (error) {
        state.lastError = error instanceof Error ? error.message : String(error);
        updateStatusBar(statusBar, state);
        await vscode.window.showErrorMessage("LLMatic runtime repair: " + state.lastError);
      }
    }),
    vscode.commands.registerCommand("llmatic.setKiloGatewayApiKey", async () => {
      const value = await vscode.window.showInputBox({
        title: "Kilo Gateway API Key",
        prompt:
          "Stored only in VS Code SecretStorage. It is not written to the repository or Kilo config.",
        password: true,
        ignoreFocusOut: true,
      });

      if (!value?.trim()) return;
      await context.secrets.store(KILO_GATEWAY_SECRET, value.trim());
      await vscode.window.showInformationMessage("Kilo Gateway API key stored securely.");
    }),
    vscode.commands.registerCommand("llmatic.clearKiloGatewayApiKey", async () => {
      await context.secrets.delete(KILO_GATEWAY_SECRET);
      await vscode.window.showInformationMessage("Kilo Gateway API key cleared.");
    }),
    vscode.commands.registerCommand("llmatic.runAgent", async () => {
      try {
        await runGatewayAgent(context, state, output);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await vscode.window.showErrorMessage("LLMatic agent: " + message);
      }
    }),
    vscode.commands.registerCommand("llmatic.review", async () => {
      try {
        await runGatewayReview(context, state, output, false);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await vscode.window.showErrorMessage("LLMatic review: " + message);
      }
    }),
    vscode.commands.registerCommand("llmatic.reviewFixLoop", async () => {
      try {
        await runGatewayReview(context, state, output, true);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await vscode.window.showErrorMessage("LLMatic review/fix loop: " + message);
      }
    }),
    vscode.commands.registerCommand("llmatic.openWorkspaceData", async () => {
      if (!state.activeWorkspace) {
        await vscode.window.showWarningMessage("No LLMatic workspace is attached.");
        return;
      }

      await vscode.commands.executeCommand(
        "revealFileInOS",
        vscode.Uri.file(state.activeWorkspace.configPath),
      );
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(async () => {
      await refresh(context, statusBar, state);
      statusProvider.update(state.health);
    }),
    vscode.workspace.onDidChangeConfiguration(async (event) => {
      if (event.affectsConfiguration("llmatic")) {
        await refresh(context, statusBar, state);
        statusProvider.update(state.health);
      }
    }),
  );

  await refresh(context, statusBar, state);
  statusProvider.update(state.health);
  await vscode.commands.executeCommand("setContext", "llmatic.health", state.health?.status);
  await offerOnboarding(context, state);
}

export function deactivate(): void {
  // No long-lived process is owned by the extension host.
}
