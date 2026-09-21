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
    expect(source).toContain('vscode.commands.registerCommand("llmatic.getReady"');
    expect(source).toContain('vscode.commands.registerCommand("llmatic.reviewFixLoop"');
    expect(source).toContain('vscode.commands.registerCommand("llmatic.checkForUpdates"');
    expect(source).toContain('vscode.commands.registerCommand("llmatic.installUpdate"');
    expect(source).toContain("export function deactivate");
  });
});
