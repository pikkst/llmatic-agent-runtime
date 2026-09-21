import { access } from "node:fs/promises";
import { resolve } from "node:path";
import * as vscode from "vscode";
import {
  ensureLlmaticGitExclude,
  initializePrivateWorkspace,
  privateWorkspacePaths,
  readGlobalKiloMcpStatus,
  registerGlobalKiloMcp,
  type KiloMcpStatus,
  type PrivateWorkspacePaths,
} from "@llmatic/workspace-manager";
import { loadAgentConfig } from "@llmatic/core";

const KILO_GATEWAY_SECRET = "llmatic.kiloGatewayApiKey";
const KILO_OFFERED_KEY = "llmatic.kiloMcpOfferShown";

interface ExtensionStatus {
  root?: string;
  paths?: PrivateWorkspacePaths;
  initialized: boolean;
  runtimeAvailable: boolean;
  runtimePath?: string;
  kilo: KiloMcpStatus;
  gatewayKeyConfigured: boolean;
}

function workspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function bundledRuntimePath(context: vscode.ExtensionContext): Promise<string | undefined> {
  const override = vscode.workspace
    .getConfiguration("llmatic")
    .get<string>("runtime.mcpServerPath")
    ?.trim();

  if (override) {
    const resolved = resolve(override);
    return (await exists(resolved)) ? resolved : undefined;
  }

  const bundled = vscode.Uri.joinPath(
    context.extensionUri,
    "dist",
    "runtime",
    "llmatic-mcp.mjs",
  ).fsPath;

  return (await exists(bundled)) ? bundled : undefined;
}

async function currentStatus(context: vscode.ExtensionContext): Promise<ExtensionStatus> {
  const root = workspaceRoot();
  const runtimePath = await bundledRuntimePath(context);
  const kilo = await readGlobalKiloMcpStatus();
  const gatewayKeyConfigured = Boolean(await context.secrets.get(KILO_GATEWAY_SECRET));

  if (!root) {
    return {
      initialized: false,
      runtimeAvailable: Boolean(runtimePath),
      runtimePath,
      kilo,
      gatewayKeyConfigured,
    };
  }

  const paths = privateWorkspacePaths(root, context.globalStorageUri.fsPath);
  let initialized = false;

  try {
    await loadAgentConfig(root, {
      LLMATIC_WORKSPACE_HOME: context.globalStorageUri.fsPath,
    });
    initialized = true;
  } catch {
    initialized = false;
  }

  return {
    root,
    paths,
    initialized,
    runtimeAvailable: Boolean(runtimePath),
    runtimePath,
    kilo,
    gatewayKeyConfigured,
  };
}

class WorkspaceTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly changed = new vscode.EventEmitter<void>();
  public readonly onDidChangeTreeData = this.changed.event;

  public constructor(private readonly context: vscode.ExtensionContext) {}

  public refresh(): void {
    this.changed.fire();
  }

  public getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  public async getChildren(): Promise<vscode.TreeItem[]> {
    const status = await currentStatus(this.context);
    const items: vscode.TreeItem[] = [];

    const workspace = new vscode.TreeItem("Workspace");
    workspace.description = status.root ?? "No folder open";
    workspace.iconPath = new vscode.ThemeIcon(status.initialized ? "pass-filled" : "circle-slash");
    workspace.command = {
      command: "llmatic.initializeWorkspace",
      title: "Initialize",
    };
    items.push(workspace);

    const runtime = new vscode.TreeItem("Runtime");
    runtime.description = status.runtimeAvailable ? "bundled MCP ready" : "MCP runtime missing";
    runtime.iconPath = new vscode.ThemeIcon(status.runtimeAvailable ? "server-process" : "warning");
    items.push(runtime);

    const kilo = new vscode.TreeItem("Kilo MCP");
    kilo.description = status.kilo.configured
      ? status.kilo.enabled
        ? "global connection enabled"
        : "configured but disabled"
      : "not connected";
    kilo.iconPath = new vscode.ThemeIcon(status.kilo.configured ? "plug" : "debug-disconnect");
    kilo.command = {
      command: "llmatic.connectKilo",
      title: "Connect Kilo",
    };
    items.push(kilo);

    const secret = new vscode.TreeItem("Kilo Gateway Key");
    secret.description = status.gatewayKeyConfigured ? "stored securely" : "not configured";
    secret.iconPath = new vscode.ThemeIcon(status.gatewayKeyConfigured ? "key" : "lock");
    secret.command = {
      command: "llmatic.setKiloGatewayApiKey",
      title: "Store API Key",
    };
    items.push(secret);

    const footprint = new vscode.TreeItem("Repo footprint");
    footprint.description = "private storage / zero tracked files";
    footprint.iconPath = new vscode.ThemeIcon("shield");
    items.push(footprint);

    return items;
  }
}

async function initializeWorkspace(context: vscode.ExtensionContext): Promise<PrivateWorkspacePaths> {
  const root = workspaceRoot();

  if (!root) {
    throw new Error("Open a Git repository before initializing LLMatic.");
  }

  const workspace = await initializePrivateWorkspace(root, context.globalStorageUri.fsPath);

  const useGitExclude = vscode.workspace
    .getConfiguration("llmatic")
    .get<boolean>("workspace.localGitExclude", true);

  if (useGitExclude) {
    await ensureLlmaticGitExclude(root);
  }

  return workspace.paths;
}

async function connectKilo(context: vscode.ExtensionContext): Promise<void> {
  const runtimePath = await bundledRuntimePath(context);

  if (!runtimePath) {
    throw new Error(
      "LLMatic MCP runtime bundle was not found. Build the extension or configure llmatic.runtime.mcpServerPath.",
    );
  }

  const nodeCommand = vscode.workspace
    .getConfiguration("llmatic")
    .get<string>("runtime.nodeCommand", "node");

  const result = await registerGlobalKiloMcp(runtimePath, context.globalStorageUri.fsPath, {
    nodeCommand,
  });

  await vscode.window.showInformationMessage(
    "LLMatic MCP registered globally in Kilo: " + result.configPath,
  );
}

async function offerKiloConnection(context: vscode.ExtensionContext): Promise<void> {
  const offered = context.globalState.get<boolean>(KILO_OFFERED_KEY, false);
  const enabled = vscode.workspace
    .getConfiguration("llmatic")
    .get<boolean>("kilo.offerGlobalMcp", true);

  if (offered || !enabled) return;

  const status = await readGlobalKiloMcpStatus();
  await context.globalState.update(KILO_OFFERED_KEY, true);

  if (status.configured) return;

  const selection = await vscode.window.showInformationMessage(
    "Connect LLMatic Agent Runtime to Kilo Code globally? This updates only your user-level Kilo config.",
    "Connect",
    "Not now",
  );

  if (selection === "Connect") {
    await connectKilo(context);
  }
}

function registerCommand(
  context: vscode.ExtensionContext,
  command: string,
  handler: () => Promise<void>,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(command, async () => {
      try {
        await handler();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await vscode.window.showErrorMessage("LLMatic: " + message);
      }
    }),
  );
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  await vscode.workspace.fs.createDirectory(context.globalStorageUri);

  const provider = new WorkspaceTreeProvider(context);
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("llmatic.workspace", provider),
  );

  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  statusBar.command = "llmatic.refreshStatus";
  context.subscriptions.push(statusBar);

  const refresh = async (): Promise<void> => {
    const status = await currentStatus(context);
    statusBar.text = status.initialized ? "$(hubot) LLMatic: READY" : "$(hubot) LLMatic: SETUP";
    statusBar.tooltip = status.root
      ? "LLMatic workspace: " + status.root
      : "Open a Git repository to initialize LLMatic.";
    statusBar.show();
    provider.refresh();
  };

  registerCommand(context, "llmatic.initializeWorkspace", async () => {
    const paths = await initializeWorkspace(context);
    await vscode.window.showInformationMessage(
      "LLMatic private workspace initialized: " + paths.workspaceDirectory,
    );
    await refresh();
  });

  registerCommand(context, "llmatic.connectKilo", async () => {
    await connectKilo(context);
    await refresh();
  });

  registerCommand(context, "llmatic.setKiloGatewayApiKey", async () => {
    const value = await vscode.window.showInputBox({
      title: "LLMatic — Kilo Gateway API Key",
      prompt: "Stored only in VS Code SecretStorage; never written to the repository.",
      password: true,
      ignoreFocusOut: true,
    });

    if (!value?.trim()) return;
    await context.secrets.store(KILO_GATEWAY_SECRET, value.trim());
    await vscode.window.showInformationMessage("Kilo Gateway API key stored securely.");
    await refresh();
  });

  registerCommand(context, "llmatic.clearKiloGatewayApiKey", async () => {
    await context.secrets.delete(KILO_GATEWAY_SECRET);
    await vscode.window.showInformationMessage("Kilo Gateway API key cleared.");
    await refresh();
  });

  registerCommand(context, "llmatic.refreshStatus", refresh);

  registerCommand(context, "llmatic.openPrivateConfig", async () => {
    const root = workspaceRoot();
    if (!root) throw new Error("No workspace folder is open.");

    const paths = privateWorkspacePaths(root, context.globalStorageUri.fsPath);
    if (!(await exists(paths.configPath))) {
      await initializeWorkspace(context);
    }

    const document = await vscode.workspace.openTextDocument(paths.configPath);
    await vscode.window.showTextDocument(document);
  });

  const autoInitialize = vscode.workspace
    .getConfiguration("llmatic")
    .get<boolean>("workspace.autoInitialize", true);

  if (autoInitialize && workspaceRoot()) {
    try {
      await initializeWorkspace(context);
    } catch (error) {
      console.error("LLMatic workspace auto-initialization failed:", error);
    }
  }

  await refresh();
  await offerKiloConnection(context);

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(async () => {
      if (autoInitialize && workspaceRoot()) {
        try {
          await initializeWorkspace(context);
        } catch (error) {
          console.error("LLMatic workspace initialization failed:", error);
        }
      }
      await refresh();
    }),
  );
}

export function deactivate(): void {}
