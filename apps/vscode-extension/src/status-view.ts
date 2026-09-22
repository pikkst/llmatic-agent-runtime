import * as vscode from "vscode";
import type { SetupHealth } from "@llmatic/setup-health";
import type { WorkspaceRecovery } from "@llmatic/workspace-recovery";

type SemanticStatus = "ok" | "attention" | "error" | "neutral";

interface StatusAction {
  label: string;
  description: string;
  icon: string;
  command: string;
}

interface StatusOperation {
  id: number;
  label: string;
  description?: string;
}

export interface AutoReviewStatus {
  enabled: boolean;
  repository?: string;
  lastReviewedPr?: number;
  lastReviewedAt?: string;
  lastReviewStatus?: "complete" | "partial";
  error?: string;
}

export interface ExternalReviewStatus {
  running: boolean;
  reference?: string;
  phase?: string;
  detail?: string;
  startedAt?: number;
  elapsedMs?: number;
  lastDurationMs?: number;
  lastCompletedAt?: string;
  error?: string;
}

export interface WorkspaceJiraStatus {
  connected: boolean;
  required: boolean;
  label?: string;
  detail?: string;
  workMode?: "assigned_only" | "project_queue";
  error?: string;
  connecting?: boolean;
  phase?: string;
}

const STATUS_COLOR_IDS: Record<Exclude<SemanticStatus, "neutral">, string> = {
  ok: "testing.iconPassed",
  attention: "list.warningForeground",
  error: "list.errorForeground",
};

function semanticColor(status: SemanticStatus): vscode.ThemeColor | undefined {
  return status === "neutral" ? undefined : new vscode.ThemeColor(STATUS_COLOR_IDS[status]);
}

function semanticResource(status: SemanticStatus, key: string): vscode.Uri | undefined {
  return status === "neutral"
    ? undefined
    : vscode.Uri.parse(
        "llmatic-status://" + status + "/" + encodeURIComponent(key.replaceAll(" ", "-")),
      );
}

function decorateStatusItem(
  item: vscode.TreeItem,
  status: SemanticStatus,
  key: string,
  icon: string,
): vscode.TreeItem {
  item.iconPath = new vscode.ThemeIcon(icon, semanticColor(status));
  item.resourceUri = semanticResource(status, key);
  return item;
}

function recoverySemanticStatus(recovery: WorkspaceRecovery): SemanticStatus {
  if (
    recovery.recommendation.action === "fix_pr" ||
    recovery.pullRequest?.ciState === "failing" ||
    recovery.pullRequest?.ciState === "cancelled"
  ) {
    return "error";
  }

  if (
    recovery.workflow ||
    recovery.task ||
    recovery.nextTask ||
    !recovery.git.clean ||
    recovery.pullRequest ||
    recovery.recommendation.action === "start_discovery"
  ) {
    return "attention";
  }

  return "ok";
}

function recommendationSemanticStatus(
  action: WorkspaceRecovery["recommendation"]["action"],
): SemanticStatus {
  if (action === "fix_pr") return "error";
  if (action === "ask_goal") return "ok";
  return "attention";
}

export class LlmaticStatusDecorationProvider implements vscode.FileDecorationProvider {
  private readonly changed = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
  public readonly onDidChangeFileDecorations = this.changed.event;

  public provideFileDecoration(uri: vscode.Uri): vscode.ProviderResult<vscode.FileDecoration> {
    if (uri.scheme !== "llmatic-status") return undefined;

    const status = uri.authority as SemanticStatus;
    const color = semanticColor(status);
    if (!color) return undefined;

    return {
      color,
      tooltip:
        status === "ok" ? "OK" : status === "attention" ? "Needs attention" : "Blocking or error",
      propagate: false,
    };
  }
}

export class LlmaticStatusProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly changed = new vscode.EventEmitter<vscode.TreeItem | undefined>();
  public readonly onDidChangeTreeData = this.changed.event;
  private health?: SetupHealth;
  private gatewayKeyConfigured = false;
  private gatewayAnonymousAvailable = false;
  private recovery?: WorkspaceRecovery;
  private jiraStatus?: WorkspaceJiraStatus;
  private autoReviewStatus?: AutoReviewStatus;
  private externalReviewStatus?: ExternalReviewStatus;
  private reviewLoggingEnabled = true;
  private nextOperationId = 0;
  private readonly operations = new Map<number, StatusOperation>();

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

  public setGatewayAccess(keyConfigured: boolean, anonymousAvailable: boolean): void {
    this.gatewayKeyConfigured = keyConfigured;
    this.gatewayAnonymousAvailable = anonymousAvailable;
    this.changed.fire(undefined);
  }

  public setJiraStatus(status: WorkspaceJiraStatus | undefined): void {
    this.jiraStatus = status;
    this.changed.fire(undefined);
    void vscode.commands.executeCommand(
      "setContext",
      "llmatic.jiraConnected",
      Boolean(status?.connected),
    );
  }

  public setAutoReviewStatus(status: AutoReviewStatus | undefined): void {
    this.autoReviewStatus = status;
    this.changed.fire(undefined);
    void vscode.commands.executeCommand(
      "setContext",
      "llmatic.autoReviewEnabled",
      Boolean(status?.enabled),
    );
  }

  public setReviewLoggingEnabled(enabled: boolean): void {
    this.reviewLoggingEnabled = enabled;
    this.changed.fire(undefined);
  }

  public beginExternalReview(reference: string): {
    update: (phase: string, detail?: string) => void;
    complete: (durationMs: number) => void;
    fail: (message: string, durationMs: number) => void;
    dispose: () => void;
  } {
    const startedAt = Date.now();
    this.externalReviewStatus = {
      running: true,
      reference,
      phase: "Starting",
      startedAt,
      elapsedMs: 0,
    };
    this.changed.fire(undefined);

    const timer = setInterval(() => {
      if (!this.externalReviewStatus?.running) return;
      this.externalReviewStatus = {
        ...this.externalReviewStatus,
        elapsedMs: Date.now() - startedAt,
      };
      this.changed.fire(undefined);
    }, 1000);

    let disposed = false;
    const disposeTimer = () => {
      if (disposed) return;
      disposed = true;
      clearInterval(timer);
    };

    return {
      update: (phase, detail) => {
        if (!this.externalReviewStatus?.running) return;
        this.externalReviewStatus = {
          ...this.externalReviewStatus,
          phase,
          detail,
          elapsedMs: Date.now() - startedAt,
        };
        this.changed.fire(undefined);
      },
      complete: (durationMs) => {
        disposeTimer();
        this.externalReviewStatus = {
          running: false,
          reference,
          phase: "Completed",
          elapsedMs: durationMs,
          lastDurationMs: durationMs,
          lastCompletedAt: new Date().toISOString(),
        };
        this.changed.fire(undefined);
      },
      fail: (message, durationMs) => {
        disposeTimer();
        this.externalReviewStatus = {
          running: false,
          reference,
          phase: "Failed",
          elapsedMs: durationMs,
          lastDurationMs: durationMs,
          lastCompletedAt: new Date().toISOString(),
          error: message,
        };
        this.changed.fire(undefined);
      },
      dispose: disposeTimer,
    };
  }

  public beginOperation(
    label: string,
    description?: string,
  ): {
    update: (nextLabel: string, nextDescription?: string) => void;
    dispose: () => void;
  } {
    const id = ++this.nextOperationId;
    this.operations.set(id, { id, label, description });
    this.changed.fire(undefined);

    return {
      update: (nextLabel, nextDescription) => {
        if (!this.operations.has(id)) return;
        this.operations.set(id, {
          id,
          label: nextLabel,
          description: nextDescription,
        });
        this.changed.fire(undefined);
      },
      dispose: () => {
        if (!this.operations.delete(id)) return;
        this.changed.fire(undefined);
      },
    };
  }

  private currentOperation(): StatusOperation | undefined {
    return Array.from(this.operations.values()).at(-1);
  }

  public getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  private formatDuration(durationMs: number | undefined): string {
    if (durationMs === undefined) return "00:00";
    const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const padded = (value: number) => String(value).padStart(2, "0");
    return hours > 0
      ? padded(hours) + ":" + padded(minutes) + ":" + padded(seconds)
      : padded(minutes) + ":" + padded(seconds);
  }

  public getChildren(): vscode.ProviderResult<vscode.TreeItem[]> {
    const operation = this.currentOperation();
    const operationItems: vscode.TreeItem[] = [];

    if (operation) {
      const loading = new vscode.TreeItem(operation.label, vscode.TreeItemCollapsibleState.None);
      decorateStatusItem(loading, "attention", "active-operation", "loading~spin");
      loading.description = operation.description ?? "LLMatic is working…";
      loading.tooltip =
        operation.label + (operation.description ? "\n" + operation.description : "");
      loading.contextValue = "llmatic.loading";
      operationItems.push(loading);
    }

    const health = this.health;
    const status = health?.status ?? "NEEDS_SETUP";
    const statusItem = new vscode.TreeItem(status, vscode.TreeItemCollapsibleState.None);

    decorateStatusItem(
      statusItem,
      status === "READY" ? "ok" : status === "NEEDS_REPAIR" ? "error" : "attention",
      "runtime",
      status === "READY" ? "pass-filled" : status === "NEEDS_REPAIR" ? "error" : "tools",
    );
    statusItem.description =
      status === "READY" ? "runtime ready" : (health?.issues.length ?? 0) + " action(s)";
    statusItem.tooltip =
      health?.issues
        .map((issue) => issue.label + (issue.detail ? ": " + issue.detail : ""))
        .join("\n") || "LLMatic is ready.";

    const recoveryItems: vscode.TreeItem[] = [];

    const jira = new vscode.TreeItem(
      this.jiraStatus?.connecting
        ? "Jira Connecting…"
        : this.jiraStatus?.connected
          ? "Jira " + (this.jiraStatus.label ?? "Workspace")
          : "Connect Jira Workspace",
      vscode.TreeItemCollapsibleState.None,
    );
    decorateStatusItem(
      jira,
      this.jiraStatus?.error
        ? "error"
        : this.jiraStatus?.connecting
          ? "attention"
          : this.jiraStatus?.connected
            ? "ok"
            : this.jiraStatus?.required
              ? "error"
              : "attention",
      "jira-workspace",
      this.jiraStatus?.error
        ? "error"
        : this.jiraStatus?.connecting
          ? "loading~spin"
          : this.jiraStatus?.connected
            ? "issues"
            : "plug",
    );
    jira.description = this.jiraStatus?.error
      ? "connection error · reconnect required"
      : this.jiraStatus?.connecting
        ? (this.jiraStatus.phase ?? "connecting…")
        : this.jiraStatus?.connected
          ? (this.jiraStatus.workMode === "project_queue" ? "project queue" : "assigned to me") +
            (this.jiraStatus.detail ? " · " + this.jiraStatus.detail : "")
          : this.jiraStatus?.required
            ? "required for canonical Jira task source"
            : "workspace-specific Jira profile";
    jira.tooltip =
      this.jiraStatus?.error ??
      (this.jiraStatus?.connecting
        ? (this.jiraStatus.phase ?? "Connecting Jira…")
        : this.jiraStatus?.connected
          ? "Jira workspace connection is healthy."
          : "Connect Jira for this workspace.");
    if (!this.jiraStatus?.connecting) {
      jira.command = {
        command: "llmatic.connectJiraWorkspace",
        title: this.jiraStatus?.connected
          ? "Edit Jira Workspace Connection"
          : "Connect Jira Workspace",
      };
    }
    recoveryItems.push(jira);

    const autoReview = new vscode.TreeItem(
      "Auto Review Agent",
      vscode.TreeItemCollapsibleState.None,
    );
    decorateStatusItem(
      autoReview,
      this.autoReviewStatus?.error ? "error" : this.autoReviewStatus?.enabled ? "ok" : "attention",
      "auto-review-agent",
      this.autoReviewStatus?.enabled ? "eye" : "eye-closed",
    );
    autoReview.description = this.autoReviewStatus?.error
      ? "error · click to configure"
      : this.autoReviewStatus?.enabled
        ? "ON · " +
          (this.autoReviewStatus.repository ?? "current repository") +
          (this.autoReviewStatus.lastReviewedPr
            ? " · last PR #" +
              this.autoReviewStatus.lastReviewedPr +
              (this.autoReviewStatus.lastReviewStatus
                ? " " + this.autoReviewStatus.lastReviewStatus
                : "")
            : "")
        : "OFF · watch new/updated PRs while VS Code is open";
    autoReview.tooltip =
      this.autoReviewStatus?.error ??
      (this.autoReviewStatus?.enabled
        ? "LLMatic watches this repository for new or updated pull requests and runs structured review automatically. Partial/transient reviews are retried after cooldown; review publication remains manual."
        : "Enable repository-bound automatic review for new or updated pull requests.");
    autoReview.command = {
      command: "llmatic.configureAutoReview",
      title: "Configure Auto Review Agent",
    };
    recoveryItems.push(autoReview);

    if (this.recovery) {
      const map = new vscode.TreeItem("Repository Map", vscode.TreeItemCollapsibleState.None);
      decorateStatusItem(
        map,
        this.recovery.repository.fileCount > 0 ? "ok" : "attention",
        "repository-map",
        "symbol-structure",
      );
      map.description =
        this.recovery.repository.fileCount +
        " files · " +
        this.recovery.repository.symbolCount +
        " symbols · " +
        this.recovery.repository.importCount +
        " imports";
      map.tooltip = "Generated " + this.recovery.repository.generatedAt;
      recoveryItems.push(map);

      const rules = new vscode.TreeItem("Repository Rules", vscode.TreeItemCollapsibleState.None);
      decorateStatusItem(
        rules,
        this.recovery.constitution.counts.proposedRule > 0 ? "attention" : "ok",
        "repository-rules",
        "law",
      );
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
      decorateStatusItem(
        recovered,
        recoverySemanticStatus(this.recovery),
        "workspace-recovery",
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
      decorateStatusItem(
        recommendation,
        recommendationSemanticStatus(this.recovery.recommendation.action),
        "recommendation",
        "sparkle",
      );
      recommendation.description = this.recovery.recommendation.detail;
      recommendation.command = {
        command: "llmatic.openAgentChat",
        title: "Open Agent Chat",
      };
      recoveryItems.push(recommendation);
    }

    const externalReview = new vscode.TreeItem(
      "External PR Review",
      vscode.TreeItemCollapsibleState.None,
    );
    if (this.externalReviewStatus?.running) {
      decorateStatusItem(externalReview, "attention", "external-pr-review", "loading~spin");
      externalReview.description =
        "PR " +
        (this.externalReviewStatus.reference ?? "?") +
        " · " +
        (this.externalReviewStatus.phase ?? "working") +
        " · " +
        this.formatDuration(this.externalReviewStatus.elapsedMs);
      externalReview.tooltip =
        "External PR review is running.\n" +
        (this.externalReviewStatus.detail ?? this.externalReviewStatus.phase ?? "") +
        "\nElapsed: " +
        this.formatDuration(this.externalReviewStatus.elapsedMs) +
        "\nClick to open the live review log.";
      externalReview.command = {
        command: "llmatic.openReviewLog",
        title: "Open Review Log",
      };
    } else if (this.externalReviewStatus?.error) {
      decorateStatusItem(externalReview, "error", "external-pr-review", "error");
      externalReview.description =
        "failed · " + this.formatDuration(this.externalReviewStatus.lastDurationMs);
      externalReview.tooltip =
        this.externalReviewStatus.error +
        "\nDuration: " +
        this.formatDuration(this.externalReviewStatus.lastDurationMs);
      externalReview.command = {
        command: "llmatic.openReviewLog",
        title: "Open Review Log",
      };
    } else {
      externalReview.iconPath = new vscode.ThemeIcon("git-pull-request");
      externalReview.description = this.externalReviewStatus?.lastDurationMs
        ? "last " +
          this.formatDuration(this.externalReviewStatus.lastDurationMs) +
          " · review another pull request"
        : "review one pull request without changing task ownership";
      externalReview.command = {
        command: "llmatic.reviewExternalPullRequest",
        title: "Review External Pull Request",
      };
    }

    const reviewLog = new vscode.TreeItem(
      "Review Activity Log",
      vscode.TreeItemCollapsibleState.None,
    );
    decorateStatusItem(
      reviewLog,
      this.reviewLoggingEnabled ? "ok" : "neutral",
      "review-activity-log",
      this.reviewLoggingEnabled ? "output" : "circle-slash",
    );
    reviewLog.description = this.reviewLoggingEnabled
      ? "ON · live + persistent telemetry"
      : "OFF · click to enable";
    reviewLog.tooltip = this.reviewLoggingEnabled
      ? "Review activity logging is enabled. Click to disable. Use Open Review Log to inspect the current session."
      : "Review activity logging is disabled. Click to enable.";
    reviewLog.command = {
      command: "llmatic.toggleReviewActivityLogging",
      title: "Toggle Review Activity Logging",
    };

    const openReviewLog = new vscode.TreeItem(
      "Open Review Log",
      vscode.TreeItemCollapsibleState.None,
    );
    openReviewLog.iconPath = new vscode.ThemeIcon("output");
    openReviewLog.description = "live phases, model steps, tools and timings";
    openReviewLog.command = {
      command: "llmatic.openReviewLog",
      title: "Open Review Log",
    };

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
        label: "Kilo Gateway",
        description: this.gatewayKeyConfigured
          ? "API key configured securely"
          : this.gatewayAnonymousAvailable
            ? "anonymous Auto Free ready · connect a key for paid models"
            : "needs connection for the selected model",
        icon: this.gatewayKeyConfigured ? "key" : "sparkle",
        command: "llmatic.connectKiloGateway",
      },
      {
        label: "External Connections",
        description: "Jira, Kilo Gateway and future service adapters",
        icon: "plug",
        command: "llmatic.openConnectionCenter",
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
        label: "Generate PR Draft",
        description: "task, validation, review, security and rule evidence",
        icon: "git-pull-request-create",
        command: "llmatic.generatePrDraft",
      },
      {
        label: "Review / Fix Loop",
        description: "review, fix, validate, re-review; key guided",
        icon: "checklist",
        command: "llmatic.reviewFixLoop",
      },
    ];

    return [
      ...operationItems,
      statusItem,
      ...recoveryItems,
      externalReview,
      reviewLog,
      openReviewLog,
      ...actions.map((action) => {
        const item = new vscode.TreeItem(action.label, vscode.TreeItemCollapsibleState.None);
        item.description = action.description;
        const gatewayAction = action.command === "llmatic.connectKiloGateway";
        const gatewayReady = this.gatewayKeyConfigured || this.gatewayAnonymousAvailable;
        item.iconPath = gatewayAction
          ? new vscode.ThemeIcon(action.icon, semanticColor(gatewayReady ? "ok" : "attention"))
          : new vscode.ThemeIcon(action.icon);
        if (gatewayAction) {
          item.resourceUri = semanticResource(gatewayReady ? "ok" : "attention", "gateway-access");
        }
        item.command = {
          command: action.command,
          title: action.label,
        };
        return item;
      }),
    ];
  }
}
