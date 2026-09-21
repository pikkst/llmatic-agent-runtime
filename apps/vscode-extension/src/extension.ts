import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import * as vscode from "vscode";
import { ensureGlobalKiloMcpServer, readGlobalKiloLlmaticServer } from "@llmatic/kilo-connector";
import { ensureManagedWorkspace, type ManagedWorkspace } from "@llmatic/workspace-manager";

const KILO_EXTENSION_ID = "kilocode.kilo-code";
const KILO_GATEWAY_SECRET = "llmatic.kiloGatewayApiKey";

interface ExtensionState {
  activeWorkspace?: ManagedWorkspace;
  kiloConnected: boolean;
  lastError?: string;
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

function bundledMcpServerPath(context: vscode.ExtensionContext): string {
  const override = configuration().get<string>("runtimeMcpPath", "").trim();
  return override || context.asAbsolutePath("dist/runtime/mcp-server.mjs");
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

async function connectKilo(context: vscode.ExtensionContext): Promise<boolean> {
  const kilo = vscode.extensions.getExtension(KILO_EXTENSION_ID);
  if (!kilo) return false;

  const serverPath = bundledMcpServerPath(context);
  if (!(await exists(serverPath))) {
    throw new Error(
      "Bundled LLMatic MCP server is missing. Build the extension runtime or configure llmatic.runtimeMcpPath.",
    );
  }

  const nodeCommand = configuration().get<string>("nodeCommand", "node").trim() || "node";

  await ensureGlobalKiloMcpServer({
    homeDirectory: homedir(),
    serverPath,
    llmaticHome: context.globalStorageUri.fsPath,
    nodeCommand,
  });

  return true;
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

    const autoConnect = configuration().get<boolean>("autoConnectKilo", true);
    state.kiloConnected = autoConnect ? await connectKilo(context) : false;
  } catch (error) {
    state.lastError = error instanceof Error ? error.message : String(error);
  }

  updateStatusBar(statusBar, state);
}

async function showStatus(context: vscode.ExtensionContext, state: ExtensionState): Promise<void> {
  const kiloInstalled = Boolean(vscode.extensions.getExtension(KILO_EXTENSION_ID));
  const kiloServer = kiloInstalled ? await readGlobalKiloLlmaticServer(homedir()) : undefined;
  const hasGatewayKey = Boolean(await context.secrets.get(KILO_GATEWAY_SECRET));

  const lines = [
    state.activeWorkspace ? "Workspace: " + state.activeWorkspace.root : "Workspace: not attached",
    state.activeWorkspace ? "Workspace data: " + state.activeWorkspace.directory : undefined,
    "Kilo Code: " + (kiloInstalled ? "installed" : "not installed"),
    "Kilo MCP: " + (kiloServer ? "configured" : "not configured"),
    "Kilo Gateway key: " + (hasGatewayKey ? "stored securely" : "not stored"),
    state.lastError ? "Error: " + state.lastError : undefined,
  ].filter((line): line is string => Boolean(line));

  await vscode.window.showInformationMessage(lines.join("\n"), { modal: true });
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  await vscode.workspace.fs.createDirectory(context.globalStorageUri);

  const state: ExtensionState = {
    kiloConnected: false,
  };

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
        state.kiloConnected = await connectKilo(context);
        state.lastError = undefined;
        updateStatusBar(statusBar, state);
        await vscode.window.showInformationMessage(
          "LLMatic MCP is registered in the global Kilo configuration.",
        );
      } catch (error) {
        state.lastError = error instanceof Error ? error.message : String(error);
        updateStatusBar(statusBar, state);
        await vscode.window.showErrorMessage(state.lastError);
      }
    }),
    vscode.commands.registerCommand("llmatic.showStatus", async () => {
      await showStatus(context, state);
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
