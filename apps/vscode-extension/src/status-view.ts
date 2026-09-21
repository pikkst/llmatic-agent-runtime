import * as vscode from "vscode";
import type { SetupHealth } from "@llmatic/setup-health";

interface StatusAction {
  label: string;
  description: string;
  icon: string;
  command: string;
}

export class LlmaticStatusProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly changed = new vscode.EventEmitter<vscode.TreeItem | undefined>();
  public readonly onDidChangeTreeData = this.changed.event;
  private health?: SetupHealth;

  public update(health: SetupHealth | undefined): void {
    this.health = health;
    this.changed.fire(undefined);
    void vscode.commands.executeCommand("setContext", "llmatic.health", health?.status);
  }

  public getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  public getChildren(): vscode.ProviderResult<vscode.TreeItem[]> {
    const health = this.health;
    const status = health?.status ?? "NEEDS_SETUP";
    const statusItem = new vscode.TreeItem(status, vscode.TreeItemCollapsibleState.None);

    statusItem.iconPath = new vscode.ThemeIcon(
      status === "READY" ? "pass-filled" : status === "NEEDS_REPAIR" ? "error" : "tools",
    );
    statusItem.description =
      status === "READY" ? "runtime ready" : (health?.issues.length ?? 0) + " action(s)";
    statusItem.tooltip =
      health?.issues
        .map((issue) => issue.label + (issue.detail ? ": " + issue.detail : ""))
        .join("\n") || "LLMatic is ready.";

    const actions: StatusAction[] = [
      {
        label: "Get Ready",
        description: "guided setup and repair",
        icon: "rocket",
        command: "llmatic.getReady",
      },
      {
        label: "Doctor",
        description: "full environment checks",
        icon: "pulse",
        command: "llmatic.doctor",
      },
      {
        label: "Check for Updates",
        description: "verify latest GitHub release manifest",
        icon: "cloud-download",
        command: "llmatic.checkForUpdates",
      },
      {
        label: "Run Gateway Agent",
        description: "kilo-auto/free by default",
        icon: "sparkle",
        command: "llmatic.runAgent",
      },
      {
        label: "Review / Fix Loop",
        description: "review, fix, validate, re-review",
        icon: "checklist",
        command: "llmatic.reviewFixLoop",
      },
    ];

    return [
      statusItem,
      ...actions.map((action) => {
        const item = new vscode.TreeItem(action.label, vscode.TreeItemCollapsibleState.None);
        item.description = action.description;
        item.iconPath = new vscode.ThemeIcon(action.icon);
        item.command = {
          command: action.command,
          title: action.label,
        };
        return item;
      }),
    ];
  }
}
