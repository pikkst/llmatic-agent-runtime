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
import { ensureManagedWorkspace, type ManagedWorkspace } from "@llmatic/workspace-manager";

const KILO_EXTENSION_ID = "kilocode.kilo-code";
const KILO_GATEWAY_SECRET = "llmatic.kiloGatewayApiKey";
const AUTO_FREE_WARNING_ACCEPTED = "llmatic.autoFreeDataWarningAccepted";

interface ExtensionState {
  activeWorkspace?: ManagedWorkspace;
  runtime?: RuntimeInstallResult;
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

function updateStatusBar(statusBar: vscode.StatusBarItem, state: ExtensionState): void {
  statusBar.command = "llmatic.showStatus";

  if (state.lastError) {
    statusBar.text = "$(error) LLMatic";
    statusBar.tooltip = state.lastError;
    statusBar.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
  } else if (!state.activeWorkspace) {
    statusBar.text = "$(circle-slash) LLMatic: no workspace";
    statusBar.tooltip = "Open a repository workspace to attach LLMatic.";
    statusBar.backgroundColor = undefined;
  } else if (!state.kiloConnected) {
    statusBar.text = "$(plug) LLMatic: workspace ready";
    statusBar.tooltip = "Workspace attached. Kilo Code MCP is not connected.";
    statusBar.backgroundColor = undefined;
  } else {
    statusBar.text = "$(check) LLMatic: READY";
    statusBar.tooltip = "Workspace attached and Kilo Code MCP configured globally.";
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

async function showStatus(context: vscode.ExtensionContext, state: ExtensionState): Promise<void> {
  const kiloInstalled = Boolean(vscode.extensions.getExtension(KILO_EXTENSION_ID));
  const kiloServer = kiloInstalled ? await readGlobalKiloLlmaticServer(homedir()) : undefined;
  const hasGatewayKey = Boolean(await context.secrets.get(KILO_GATEWAY_SECRET));

  const lines = [
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

  context.subscriptions.push(
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
    }),
    vscode.workspace.onDidChangeConfiguration(async (event) => {
      if (event.affectsConfiguration("llmatic")) {
        await refresh(context, statusBar, state);
      }
    }),
  );

  await refresh(context, statusBar, state);
}

export function deactivate(): void {
  // No long-lived process is owned by the extension host.
}
