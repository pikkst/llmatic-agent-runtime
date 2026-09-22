import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("VS Code extension activation surface", () => {
  it("keeps the full activation entrypoint and critical commands", async () => {
    const source = await readFile(new URL("../src/extension.ts", import.meta.url), "utf8");

    expect(source.length).toBeGreaterThan(20000);
    expect(source).toContain("export async function activate");
    expect(source).toContain('vscode.commands.registerCommand("llmatic.startDiscovery"');
    expect(source).toContain('vscode.commands.registerCommand("llmatic.generatePlan"');
    expect(source).toContain('vscode.commands.registerCommand("llmatic.reviewPlan"');
    expect(source).toContain('vscode.commands.registerCommand("llmatic.planReview"');
    expect(source).toContain('vscode.commands.registerCommand("llmatic.approveAndInitialize"');
    expect(source).toContain('vscode.commands.registerCommand("llmatic.getReady"');
    expect(source).toContain('vscode.commands.registerCommand("llmatic.setKiloGatewayApiKey"');
    expect(source).toContain('vscode.commands.registerCommand("llmatic.reviewFixLoop"');
    expect(source).toContain('vscode.commands.registerCommand("llmatic.openAgentChat"');
    expect(source).toContain('vscode.commands.registerCommand("llmatic.connectJiraWorkspace"');
    expect(source).toContain('vscode.commands.registerCommand("llmatic.disconnectJiraWorkspace"');
    expect(source).toContain('vscode.commands.registerCommand("llmatic.connectKiloGateway"');
    expect(source).toContain('vscode.commands.registerCommand("llmatic.openConnectionCenter"');
    expect(source).toContain('vscode.commands.registerCommand("llmatic.refreshWorkspaceRecovery"');
    expect(source).toContain('vscode.commands.registerCommand("llmatic.showRepositoryRules"');
    expect(source).toContain('vscode.commands.registerCommand("llmatic.reviewRuleProposals"');
    expect(source).toContain('vscode.commands.registerCommand("llmatic.generatePrDraft"');
    expect(source).toContain('vscode.commands.registerCommand("llmatic.checkForUpdates"');
    expect(source).toContain('vscode.commands.registerCommand("llmatic.installUpdate"');
    expect(source).toContain("loadProjectChangeRequest");
    expect(source).toContain("changeRequest: pendingChangeRequest?.text");
    expect(source).toContain("vscode.extensions.onDidChange");
    expect(source).toContain("Kilo Code installation detected; resuming Get Ready.");
    expect(source).toContain("gatewayAccessOrPrompt");
    expect(source).toContain("Use anonymous Auto Free");
    expect(source).toContain("Get a Kilo Gateway API key");
    expect(source).toContain("https://app.kilo.ai");
    expect(source).toContain("recoverWorkspace");
    expect(source).toContain("workspaceRecoveryContext");
    expect(source).toContain("verifyJiraConnectionFromEnvironment");
    expect(source).toContain("startBrokerConnection");
    expect(source).toContain("pollBrokerConnection");
    expect(source).toContain("refreshBrokerCredential");
    expect(source).toContain("Continue with Atlassian");
    expect(source).toContain("JIRA_PROFILE_STATE_KEY");
    expect(source).toContain("jiraSecretKey");
    expect(source).toContain('"assigned_only"');
    expect(source).toContain('"project_queue"');
    expect(source).toContain("AgentChatViewProvider");
    expect(source).toContain("runAgentChatTurn");
    expect(source).toContain("decideRepositoryRuleProposal");
    expect(source).toContain("buildPullRequestDraft");
    expect(source).toContain("loadLatestReviewReport");
    expect(source).toContain('lenses: ["general", "bug_hunter", "security"]');
    expect(source).toContain("allowAdHoc: true");
    expect(source).toContain('"Set API Key"');
    expect(source).toContain("password: true");
    expect(source).toContain("Kilo Code and the LLMatic MCP connection remain usable without it.");
    expect(source).toContain("export function deactivate");
  });

  it("surfaces secure Gateway key setup in the LLMatic Activity Bar", async () => {
    const source = await readFile(new URL("../src/status-view.ts", import.meta.url), "utf8");

    expect(source).toContain("gatewayKeyConfigured");
    expect(source).toContain("Set Kilo Gateway API Key");
    expect(source).toContain("configured securely — click to replace");
    expect(source).toContain("Kilo Gateway");
    expect(source).toContain("anonymous Auto Free ready");
    expect(source).toContain('command: "llmatic.connectKiloGateway"');
    expect(source).toContain("External Connections");
    expect(source).toContain("WorkspaceJiraStatus");
    expect(source).toContain("Connect Jira Workspace");
    expect(source).toContain("assigned to me");
    expect(source).toContain("project queue");
    expect(source).toContain("testing.iconPassed");
    expect(source).toContain("list.warningForeground");
    expect(source).toContain("list.errorForeground");
  });
  it("contributes a persistent Agent Chat webview with repository recovery controls", async () => {
    const packageJson = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as {
      contributes: {
        views: { llmatic: Array<{ id: string; type?: string }> };
        configuration: { properties: Record<string, unknown> };
      };
    };

    expect(packageJson.contributes.views.llmatic).toContainEqual(
      expect.objectContaining({
        id: "llmatic.agentChat",
        type: "webview",
      }),
    );
    expect(packageJson.contributes.configuration.properties).toHaveProperty("llmatic.taskSource");
    expect(packageJson.contributes.configuration.properties).toHaveProperty(
      "llmatic.jiraProjectKey",
    );
    expect(packageJson.contributes.configuration.properties).toHaveProperty("llmatic.jiraWorkMode");

    const source = await readFile(new URL("../src/agent-chat-view.ts", import.meta.url), "utf8");
    expect(source).toContain("Continue recommended");
    expect(source).toContain("Refresh context");
    expect(source).toContain("conversationHistory");
    expect(source).toContain("Repository map");
    expect(source).toContain("Repository rules");
    expect(source).toContain("Latest review");
    expect(source).toContain('type: "continue"');
    expect(source).toContain('type: "ready"');
    expect(source).toContain('input.type === "ready"');
    expect(source).toContain("status-ok");
    expect(source).toContain("status-attention");
    expect(source).toContain("status-error");
  });
});
