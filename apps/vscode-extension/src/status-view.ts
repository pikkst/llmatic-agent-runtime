import * as vscode from "vscode";
import type { SetupHealth } from "@llmatic/setup-health";
import type { WorkspaceRecovery } from "@llmatic/workspace-recovery";

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
  private gatewayKeyConfigured = false;
  private recovery?: WorkspaceRecovery;

  public update(
    health: SetupHealth | undefined,
    gatewayKeyConfigured = this.gatewayKeyConfigured,
    recovery = this.recovery,
  ): void {
    this.health = health;
    this.gatewayKeyConfigured = gatewayKeyConfigured;
    this.recovery = recovery;
    this.changed.fire(undefined);
    void vscode.commands.executeCommand("setContext", "llmatic.health", health?.status);
    void vscode.commands.executeCommand(
      "setContext",
      "llmatic.gatewayKeyConfigured",
      gatewayKeyConfigured,
    );
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

    const recoveryItems: vscode.TreeItem[] = [];
    if (this.recovery) {
      const map = new vscode.TreeItem("Repository Map", vscode.TreeItemCollapsibleState.None);
      map.iconPath = new vscode.ThemeIcon("symbol-structure");
      map.description =
        this.recovery.repository.fileCount +
        " files · " +
        this.recovery.repository.symbolCount +
        " symbols · " +
        this.recovery.repository.importCount +
        " imports";
      map.tooltip = "Generated " + this.recovery.repository.generatedAt;
      recoveryItems.push(map);

      const rules = new vscode.TreeItem(
        "Repository Rules",
        vscode.TreeItemCollapsibleState.None,
      );
      rules.iconPath = new vscode.ThemeIcon("law");
      rules.description =
        this.recovery.constitution.counts.explicitRule +
        " explicit · " +
        this.recovery.constitution.counts.approvedRule +
        " approved · " +
        this.recovery.constitution.counts.inferredConvention +
        " inferred";
      rules.tooltip =
        this.recovery.constitution.counts.blocking +
        " blocking active rule(s); " +
        this.recovery.constitution.counts.proposedRule +
        " proposed rule(s) awaiting review.";
      rules.command = {
        command: "llmatic.openAgentChat",
        title: "Open Agent Chat",
      };
      recoveryItems.push(rules);

      const recovered = new vscode.TreeItem(
        this.recovery.workflow
          ? "Workflow " + this.recovery.workflow.taskRef
          : this.recovery.task
            ? "Task " + this.recovery.task.key
            : this.recovery.nextTask
              ? "Next " + this.recovery.nextTask.key
              : "Workspace Recovery",
        vscode.TreeItemCollapsibleState.None,
      );
      recovered.iconPath = new vscode.ThemeIcon(
        this.recovery.pullRequest ? "git-pull-request" : "tasklist",
      );
      recovered.description = this.recovery.pullRequest
        ? "PR #" +
          this.recovery.pullRequest.pullRequest.number +
          " · CI " +
          this.recovery.pullRequest.ciState
        : this.recovery.workflow
          ? this.recovery.workflow.state
          : this.recovery.task
            ? this.recovery.task.status.name
            : this.recovery.nextTask
              ? this.recovery.nextTask.summary
              : "no active task";
      recovered.tooltip =
        this.recovery.recommendation.title + "\n" + this.recovery.recommendation.detail;
      recovered.command = {
        command: "llmatic.openAgentChat",
        title: "Open Agent Chat",
      };
      recoveryItems.push(recovered);

      const recommendation = new vscode.TreeItem(
        "Next: " + this.recovery.recommendation.title,
        vscode.TreeItemCollapsibleState.None,
      );
      recommendation.iconPath = new vscode.ThemeIcon("sparkle");
      recommendation.description = this.recovery.recommendation.detail;
      recommendation.command = {
        command: "llmatic.openAgentChat",
        title: "Open Agent Chat",
      };
      recoveryItems.push(recommendation);
    }

    const actions: StatusAction[] = [
      {
        label: "New Project Discovery",
        description: "adaptive questions, best-practice recommendations",
        icon: "comment-discussion",
        command: "llmatic.startDiscovery",
      },
      {
        label: "Generate Project Plan",
        description: "private architecture, roadmap and task graph",
        icon: "project",
        command: "llmatic.generatePlan",
      },
      {
        label: "Review Project Plan",
        description: "inspect private plan artifacts",
        icon: "preview",
        command: "llmatic.reviewPlan",
      },
      {
        label: "Review & Approve Plan",
        description: "edit, regenerate, request changes or initialize",
        icon: "verified",
        command: "llmatic.planReview",
      },
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
        label: this.gatewayKeyConfigured ? "Kilo Gateway API Key" : "Set Kilo Gateway API Key",
        description: this.gatewayKeyConfigured
          ? "configured securely — click to replace"
          : "optional; required for direct agent and review",
        icon: "key",
        command: "llmatic.setKiloGatewayApiKey",
      },
      {
        label: "Check for Updates",
        description: "verify latest GitHub release manifest",
        icon: "cloud-download",
        command: "llmatic.checkForUpdates",
      },
      {
        label: "Install Latest Update",
        description: "download, hash-verify, then install VSIX",
        icon: "cloud-download",
        command: "llmatic.installUpdate",
      },
      {
        label: "Agent Chat",
        description: "persistent repo-aware conversation",
        icon: "comment-discussion",
        command: "llmatic.openAgentChat",
      },
      {
        label: "Repository Rules",
        description: "explicit, approved, inferred and proposed project rules",
        icon: "law",
        command: "llmatic.showRepositoryRules",
      },
      {
        label: "Review Rule Proposals",
        description: "approve or reject learned project rules",
        icon: "check-all",
        command: "llmatic.reviewRuleProposals",
      },
      {
        label: "Refresh Repository Context",
        description: "re-index repo and recover task / PR / CI state",
        icon: "refresh",
        command: "llmatic.refreshWorkspaceRecovery",
      },
      {
        label: "Review / Fix Loop",
        description: "review, fix, validate, re-review; key guided",
        icon: "checklist",
        command: "llmatic.reviewFixLoop",
      },
    ];

    return [
      statusItem,
      ...recoveryItems,
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
