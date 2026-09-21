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
    expect(source).toContain('vscode.commands.registerCommand("llmatic.checkForUpdates"');
    expect(source).toContain('vscode.commands.registerCommand("llmatic.installUpdate"');
    expect(source).toContain("loadProjectChangeRequest");
    expect(source).toContain("changeRequest: pendingChangeRequest?.text");
    expect(source).toContain("vscode.extensions.onDidChange");
    expect(source).toContain("Kilo Code installation detected; resuming Get Ready.");
    expect(source).toContain("gatewayApiKeyOrPrompt");
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
    expect(source).toContain("optional; required for direct agent and review");
    expect(source).toContain('command: "llmatic.setKiloGatewayApiKey"');
  });
});
