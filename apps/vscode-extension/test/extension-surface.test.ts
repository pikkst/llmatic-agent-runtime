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
    expect(source).toContain('vscode.commands.registerCommand("llmatic.agentChatProbe"');
    expect(source).toContain('vscode.commands.registerCommand("llmatic.connectJiraWorkspace"');
    expect(source).toContain('vscode.commands.registerCommand("llmatic.disconnectJiraWorkspace"');
    expect(source).toContain('vscode.commands.registerCommand("llmatic.connectKiloGateway"');
    expect(source).toContain('vscode.commands.registerCommand("llmatic.openConnectionCenter"');
    expect(source).toContain('vscode.commands.registerCommand("llmatic.refreshWorkspaceRecovery"');
    expect(source).toContain('vscode.commands.registerCommand("llmatic.showRepositoryRules"');
    expect(source).toContain('vscode.commands.registerCommand("llmatic.reviewRuleProposals"');
    expect(source).toContain('vscode.commands.registerCommand("llmatic.generatePrDraft"');
    expect(source).toContain('"llmatic.reviewExternalPullRequest"');
    expect(source).toContain('"llmatic.configureAutoReview"');
    expect(source).toContain('vscode.commands.registerCommand("llmatic.openReviewLog"');
    expect(source).toContain(
      'vscode.commands.registerCommand("llmatic.toggleReviewActivityLogging"',
    );
    expect(source).toContain('vscode.commands.registerCommand("llmatic.checkForUpdates"');
    expect(source).toContain('vscode.commands.registerCommand("llmatic.installUpdate"');
    expect(source).toContain("[RAW GATEWAY RESPONSE BEGIN]");
    expect(source).toContain("reviewRawResponseLogging");
    expect(source).toContain("loadProjectChangeRequest");
    expect(source).toContain("changeRequest: pendingChangeRequest?.text");
    expect(source).toContain("vscode.extensions.onDidChange");
    expect(source).toContain("Kilo Code installation detected; resuming Get Ready.");
    expect(source).toContain("gatewayAccessOrPrompt");
    expect(source).toContain("Use anonymous Auto Free");
    expect(source).toContain("Get a Kilo Gateway API key");
    expect(source).toContain("recoverWorkspace");
    expect(source).toContain("workspaceRecoveryContext");
    expect(source).toContain("verifyJiraConnectionFromEnvironment");
    expect(source).toContain("getBrokerHealth");
    expect(source).toContain("startBrokerConnection");
    expect(source).toContain("pollBrokerConnection");
    expect(source).toContain("refreshBrokerCredential");
    expect(source).toContain("Continue with Atlassian");
    expect(source).toContain("Atlassian is not ready");
    expect(source).toContain("not the Jira site URL");
    expect(source).toContain("Configure Broker URL");
    expect(source).toContain("Use Manual Connection");
    expect(source).toContain("setJiraConnectionError");
    expect(source).toContain("handleJiraConnectionFailure");
    expect(source).toContain("jiraConnectionError");
    expect(source).toContain("state.jiraConnectionError = message");
    expect(source).toContain("checking OAuth broker…");
    expect(source).toContain("starting Atlassian sign-in…");
    expect(source).toContain("waiting for browser authorization…");
    expect(source).toContain("loading Jira projects…");
    expect(source).toContain("refreshing repository context…");
    expect(source).toContain("JIRA_PROFILE_STATE_KEY");
    expect(source).toContain("jiraSecretKey");
    expect(source).toContain('"assigned_only"');
    expect(source).toContain('"project_queue"');
    expect(source).toContain("AgentChatViewProvider");
    expect(source).toContain("runAgentChatTurn");
    expect(source).toContain("formatAgentActivity");
    expect(source).toContain('"Thinking…"');
    expect(source).toContain('"Searching the repository…"');
    expect(source).toContain("Model provider temporarily unavailable — retrying");
    expect(source).toContain("[RETRY] Kilo Gateway");
    expect(source).toContain("AdaptiveFreeGatewayClient");
    expect(source).toContain("[MODEL ROUTER]");
    expect(source).toContain('sessionId = "auto-" + reference');
    expect(source).toContain("=== LLMatic Auto Review PR #");
    expect(source).toContain("CI snapshot");
    expect(source).toContain("reviewStatus = statusProvider.beginExternalReview(reference)");
    expect(source).toContain(
      "appendReviewActivity(context, reviewLog, sessionId, reference, startedAt, event)",
    );
    expect(source).toContain(
      "runAutoReviewScan(context, state, statusProvider, output, reviewLog",
    );
    expect(source).toContain("This is not a clean-review verdict");
    expect(source).toContain("Publish Partial Review");
    expect(source).toContain("Diff coverage");
    expect(source).not.toContain("chatProvider.appendActivity(line");
    expect(source).toContain("decideRepositoryRuleProposal");
    expect(source).toContain("buildPullRequestDraft");
    expect(source).toContain("loadLatestReviewReport");
    expect(source).toContain('lenses: ["general", "bug_hunter", "security"]');
    expect(source).toContain("allowAdHoc: true");
    expect(source).toContain('"Connect Kilo Gateway"');
    expect(source).toContain("password: true");
    expect(source).toContain("Auto Free can run anonymously");
    expect(source).toContain("export function deactivate");
  });

  it("surfaces secure Gateway key setup in the LLMatic Activity Bar", async () => {
    const source = await readFile(new URL("../src/status-view.ts", import.meta.url), "utf8");

    expect(source).toContain("gatewayKeyConfigured");
    expect(source).toContain("Kilo Gateway");
    expect(source).toContain("API key configured securely");
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
    expect(source).toContain("connection error · reconnect required");
    expect(source).toContain("loading~spin");
    expect(source).toContain("connecting…");
    expect(source).toContain("beginOperation");
    expect(source).toContain("active-operation");
    expect(source).toContain("External PR Review");
    expect(source).toContain("activeExternalReviewId");
    expect(source).toContain("activeExternalReviewTimer");
    expect(source).toContain('finish("Stopped", Date.now() - startedAt)');
    expect(source).toContain("Auto Review Agent");
    expect(source).toContain("Review Activity Log");
    expect(source).toContain("loading~spin");
    expect(source).toContain("live + persistent telemetry");
    expect(source).toContain("formatDuration");
    expect(source).toContain('command: "llmatic.reviewExternalPullRequest"');
    expect(source).toContain('command: "llmatic.configureAutoReview"');
    expect(source).toContain("LLMatic is working…");
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
    expect(packageJson.contributes.configuration.properties).toHaveProperty(
      "llmatic.connectionBrokerUrl",
    );
    expect(packageJson.contributes.configuration.properties).toHaveProperty(
      "llmatic.allowAnonymousKiloFree",
    );
    expect(packageJson.contributes.configuration.properties).toHaveProperty(
      "llmatic.reviewActivityLogging",
    );
    expect(packageJson.contributes.configuration.properties).toHaveProperty(
      "llmatic.reviewRawResponseLogging",
    );
    expect(
      (
        packageJson.contributes.configuration.properties["llmatic.reviewRequestTimeoutMs"] as {
          default?: number;
        }
      ).default,
    ).toBe(60000);
    expect(packageJson.contributes.configuration.properties).toHaveProperty(
      "llmatic.reviewMaxSteps",
    );
    expect(packageJson.contributes.configuration.properties).toHaveProperty(
      "llmatic.externalReviewMaxSteps",
    );
    expect(packageJson.contributes.configuration.properties).toHaveProperty(
      "llmatic.reviewRequestTimeoutMs",
    );
    expect(packageJson.contributes.configuration.properties).toHaveProperty(
      "llmatic.reviewFreeModelFallbacks",
    );

    const connectionSource = await readFile(
      new URL("../../../packages/external-connections/src/index.ts", import.meta.url),
      "utf8",
    );
    expect(connectionSource).toContain("https://app.kilo.ai");
    expect(connectionSource).toContain("browser_oauth");
    expect(connectionSource).toContain("browser_api_key");

    const source = await readFile(new URL("../src/agent-chat-view.ts", import.meta.url), "utf8");
    expect(source).toContain("Continue recommended");
    expect(source).toContain("Refresh context");
    expect(source).toContain("conversationHistory");
    const clientSource = await readFile(new URL("../media/agent-chat.js", import.meta.url), "utf8");
    expect(clientSource).toContain("Repository map");
    expect(clientSource).toContain("Repository rules");
    expect(clientSource).toContain("Latest review");
    expect(() => new Function(clientSource)).not.toThrow();
    expect(clientSource).toContain('type: "continue"');
    expect(clientSource).toContain('type: "ready"');
    expect(source).toContain('input.type === "ready"');
    expect(source.indexOf("onDidReceiveMessage")).toBeLessThan(
      source.indexOf("view.webview.html = this.html"),
    );
    expect(source).toContain("onDidChangeVisibility");
    expect(source).toContain("onDidDispose");
    expect(source).toContain("syncRetryCount");
    expect(source).toContain("stateRevision");
    expect(source).toContain("acknowledgedRevision");
    expect(source).toContain("scheduleStateRetry");
    expect(source).toContain('input.type === "state-applied"');
    expect(clientSource).toContain(
      'vscode.postMessage({ type: "state-applied", revision: state.revision })',
    );
    expect(source).toContain("this.acknowledgedRevision >= revision");
    expect(source).toContain("localResourceRoots");
    expect(source).toContain("agent-chat.js");
    expect(source).toContain("asWebviewUri");
    expect(source).toContain("waitUntilClientReady");
    expect(source).toContain("setRecoverySource");
    expect(source).toContain("currentRecovery");
    expect(clientSource).toContain("receivedState");
    expect(clientSource).toContain("if (!receivedState)");
    expect(source).toContain("messages.map");
    expect(source).toContain("status-ok");
    expect(source).toContain("status-attention");
    expect(source).toContain("status-error");
    expect(source).toContain("busy-indicator");
    expect(source).toContain("llmatic-spin");
    expect(clientSource).toContain("Working…");
    expect(clientSource).toContain("acquireVsCodeApi");
    expect(clientSource).toContain("Agent Chat client failed to start");
  });
  it("packages one fresh VSIX candidate under generic and versioned names", async () => {
    const source = await readFile(new URL("../scripts/package-vsix.mjs", import.meta.url), "utf8");
    const workspaceBuildCall = 'runPnpm(["run", "build"], "VSIX workspace build", repositoryRoot)';
    const vsixPackageCall = '["exec", "vsce", "package"';

    expect(source).toContain(workspaceBuildCall);
    expect(source).toContain("rm(output, { force: true })");
    expect(source).toContain("rm(versionedOutput, { force: true })");
    expect(source).toContain("copyFile(output, versionedOutput)");
    expect(source).toContain("VSIX CANDIDATE PACKAGED");
    expect(source).toContain("VSIX SHA-256");
    expect(source).toContain('spawnSync("git", ["rev-parse", "HEAD"]');
    expect(source.indexOf(workspaceBuildCall)).toBeLessThan(source.indexOf(vsixPackageCall));
  });
  it("keeps the v0.3.1 release pipeline deterministic with a manual Marketplace handoff", async () => {
    const [rootPackageRaw, extensionPackageRaw, workflow, marketplaceDocs] = await Promise.all([
      readFile(new URL("../../../package.json", import.meta.url), "utf8"),
      readFile(new URL("../package.json", import.meta.url), "utf8"),
      readFile(new URL("../../../.github/workflows/release.yml", import.meta.url), "utf8"),
      readFile(new URL("../../../docs/marketplace-publishing.md", import.meta.url), "utf8"),
    ]);

    const rootPackage = JSON.parse(rootPackageRaw) as { version: string };
    const extensionPackage = JSON.parse(extensionPackageRaw) as { version: string };

    expect(rootPackage.version).toBe("0.3.1");
    expect(extensionPackage.version).toBe(rootPackage.version);

    expect(workflow).toContain("pnpm install --frozen-lockfile");
    expect(workflow).toContain("group: release-${{ github.ref }}");
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).toContain("permissions:\n  contents: read");
    expect(workflow).toContain("permissions:\n      contents: write");
    expect(workflow).toContain("Marketplace publication is intentionally manual.");
    expect(workflow).not.toContain("marketplace_publish:");
    expect(workflow).not.toContain("--oidc");
    expect(workflow).not.toContain("--azure-credential");
    expect(workflow).not.toContain("VSCODE_MARKETPLACE_");
    expect(workflow).not.toContain("marketplace-production");

    expect(marketplaceDocs).toContain("manual Visual Studio Marketplace upload");
    expect(marketplaceDocs).toContain(
      "Do not rebuild the extension locally for Marketplace publication",
    );
    expect(marketplaceDocs).toContain("VSCODE_MARKETPLACE_PUBLISH");
    expect(marketplaceDocs).toContain("can be deleted after this cleanup is merged");
  });

  it("keeps VS Code clean-install identity verification inside the Extension Host", async () => {
    const source = await readFile(
      new URL("../../../scripts/vscode-clean-install-acceptance.mjs", import.meta.url),
      "utf8",
    );

    expect(source).not.toContain('"--list-extensions"');
    expect(source).toContain(
      "installed extension was not loaded from the isolated VSIX extensions directory",
    );
    expect(source).toContain("target.packageJSON.version");
    expect(source).toContain("await target.activate()");
    expect(source).toContain("llmatic.agentChatProbe");
  });
});
