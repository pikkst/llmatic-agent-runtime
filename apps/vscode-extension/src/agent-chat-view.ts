import * as vscode from "vscode";
import type { CodingAgentConversationTurn } from "@llmatic/agent-orchestrator";
import type { CodeReviewReport } from "@llmatic/review-engine";
import type { WorkspaceRecovery } from "@llmatic/workspace-recovery";

type ChatMessage =
  | { role: "user" | "assistant"; content: string }
  | { role: "activity"; content: string; success?: boolean };

export interface AgentChatHandlers {
  send(text: string): Promise<void>;
  refresh(): Promise<void>;
  continueRecommended(): Promise<void>;
}

export class AgentChatViewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private recovery?: WorkspaceRecovery;
  private recoverySource?: () => WorkspaceRecovery | undefined;
  private review?: CodeReviewReport;
  private readonly messages: ChatMessage[] = [];
  private busy = false;
  private busyLabel = "LLMatic is working…";
  private stateRevision = 0;
  private acknowledgedRevision = 0;
  private syncRetryCount = 0;
  private syncRetry?: ReturnType<typeof setTimeout>;
  private handlers?: AgentChatHandlers;
  private clientReady = false;
  private clientError?: string;
  private readonly clientReadyWaiters = new Set<(ready: boolean) => void>();

  public constructor(private readonly extensionUri: vscode.Uri) {}

  public setHandlers(handlers: AgentChatHandlers): void {
    this.handlers = handlers;
  }

  public setRecoverySource(source: () => WorkspaceRecovery | undefined): void {
    this.recoverySource = source;
    this.sync();
  }

  public waitUntilClientReady(timeoutMs = 5_000): Promise<boolean> {
    if (this.clientReady) return Promise.resolve(true);
    if (this.clientError) return Promise.resolve(false);

    return new Promise((resolveReady) => {
      let waiter: (ready: boolean) => void;
      const timeout = setTimeout(() => {
        this.clientReadyWaiters.delete(waiter);
        resolveReady(false);
      }, timeoutMs);

      waiter = (ready) => {
        clearTimeout(timeout);
        this.clientReadyWaiters.delete(waiter);
        resolveReady(ready);
      };

      this.clientReadyWaiters.add(waiter);
    });
  }

  private markClientReady(ready: boolean, error?: string): void {
    this.clientReady = ready;
    this.clientError = error;
    for (const waiter of this.clientReadyWaiters) waiter(ready);
    this.clientReadyWaiters.clear();
  }

  private currentRecovery(): WorkspaceRecovery | undefined {
    return this.recoverySource?.() ?? this.recovery;
  }

  public resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.clientReady = false;
    this.clientError = undefined;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")],
    };

    // Register the extension-side receiver before assigning HTML. The webview
    // posts a ready handshake during script startup, and a fast webview could
    // otherwise beat listener registration and remain permanently unhydrated.
    view.webview.onDidReceiveMessage(async (message: unknown) => {
      if (!message || typeof message !== "object") return;
      const input = message as Record<string, unknown>;

      if (input.type === "client-error") {
        this.markClientReady(
          false,
          typeof input.message === "string" ? input.message : "Agent Chat client failed to start.",
        );
        return;
      }

      if (input.type === "state-applied" && typeof input.revision === "number") {
        this.acknowledgeState(input.revision);
        return;
      }

      if (input.type === "ready") {
        this.markClientReady(true);
        this.sync();
        return;
      }

      if (input.type === "refresh") {
        if (!this.busy) await this.handlers?.refresh();
        return;
      }

      if (input.type === "continue") {
        if (!this.busy) await this.handlers?.continueRecommended();
        return;
      }

      if (input.type !== "send" || typeof input.text !== "string") return;
      const text = input.text.trim();
      if (!text || this.busy) return;

      this.messages.push({ role: "user", content: text });
      this.sync();

      try {
        await this.handlers?.send(text);
      } catch (error) {
        this.appendAssistant(
          "Agent request failed: " + (error instanceof Error ? error.message : String(error)),
        );
      }
    });

    view.onDidChangeVisibility(() => {
      if (view.visible) this.sync();
    });
    view.onDidDispose(() => {
      if (this.view === view) this.view = undefined;
      this.clientReady = false;
      this.clientError = undefined;
      for (const waiter of this.clientReadyWaiters) waiter(false);
      this.clientReadyWaiters.clear();
      if (this.syncRetry) clearTimeout(this.syncRetry);
      this.syncRetry = undefined;
      this.syncRetryCount = 0;
    });

    view.webview.html = this.html(view.webview);
    this.sync();
  }

  public setRecovery(recovery: WorkspaceRecovery | undefined): void {
    this.recovery = recovery;
    this.sync();
  }

  public setReview(review: CodeReviewReport | undefined): void {
    this.review = review;
    this.sync();
  }

  public appendAssistant(content: string): void {
    const text = content.trim();
    if (!text) return;
    this.messages.push({ role: "assistant", content: text });
    this.sync();
  }

  public appendActivity(content: string, success?: boolean): void {
    const text = content.trim();
    if (!text) return;
    this.messages.push({ role: "activity", content: text, success });
    if (this.messages.length > 100) {
      const preserved = this.messages.filter((message) => message.role !== "activity");
      const recentActivity = this.messages
        .filter((message) => message.role === "activity")
        .slice(-30);
      this.messages.splice(0, this.messages.length, ...preserved, ...recentActivity);
    }
    this.sync();
  }

  public setBusy(busy: boolean, label = "LLMatic is working…"): void {
    this.busy = busy;
    this.busyLabel = label;
    this.sync();
  }

  public conversationHistory(): CodingAgentConversationTurn[] {
    return this.messages
      .filter(
        (message): message is Extract<ChatMessage, { role: "user" | "assistant" }> =>
          message.role === "user" || message.role === "assistant",
      )
      .slice(0, -1)
      .map((message) => ({ role: message.role, content: message.content }));
  }

  public clear(): void {
    this.messages.length = 0;
    this.sync();
  }

  private sync(): void {
    if (!this.view) return;

    this.stateRevision += 1;
    this.syncRetryCount = 0;
    if (this.syncRetry) clearTimeout(this.syncRetry);
    this.syncRetry = undefined;
    this.postState(this.stateRevision);
  }

  private postState(revision: number): void {
    if (!this.view || revision !== this.stateRevision) return;

    const view = this.view;
    const recovery = this.currentRecovery();
    const message = {
      type: "state",
      revision,
      busy: this.busy,
      busyLabel: this.busyLabel,
      review: this.review
        ? {
            summary: this.review.summary,
            blockingCount: this.review.blockingCount,
            nonBlockingCount: this.review.nonBlockingCount,
            lenses: this.review.lenses,
            findings: this.review.findings.slice(0, 20).map((finding) => ({
              severity: finding.severity,
              lens: finding.lens,
              title: finding.title,
              path: finding.path,
              line: finding.line,
              ruleId: finding.ruleId,
            })),
          }
        : undefined,
      recovery: recovery
        ? {
            repository: {
              generatedAt: recovery.repository.generatedAt,
              fileCount: recovery.repository.fileCount,
              sourceFileCount: recovery.repository.sourceFileCount,
              symbolCount: recovery.repository.symbolCount,
              importCount: recovery.repository.importCount,
            },
            git: {
              branch: recovery.git.branch,
              detached: recovery.git.detached,
              clean: recovery.git.clean,
              stagedCount: recovery.git.stagedCount,
              unstagedCount: recovery.git.unstagedCount,
              untrackedCount: recovery.git.untrackedCount,
            },
            workflow: recovery.workflow
              ? {
                  taskRef: recovery.workflow.taskRef,
                  state: recovery.workflow.state,
                }
              : undefined,
            task: recovery.task
              ? {
                  key: recovery.task.key,
                  summary: recovery.task.summary,
                  status: recovery.task.status.name,
                }
              : undefined,
            nextTask: recovery.nextTask
              ? {
                  key: recovery.nextTask.key,
                  summary: recovery.nextTask.summary,
                }
              : undefined,
            pullRequest: recovery.pullRequest
              ? {
                  number: recovery.pullRequest.pullRequest.number,
                  ciState: recovery.pullRequest.ciState,
                }
              : undefined,
            taskSource: recovery.taskSource.selected,
            constitution: {
              explicitRule: recovery.constitution.counts.explicitRule,
              approvedRule: recovery.constitution.counts.approvedRule,
              inferredConvention: recovery.constitution.counts.inferredConvention,
              proposedRule: recovery.constitution.counts.proposedRule,
              blocking: recovery.constitution.counts.blocking,
            },
            recommendation: recovery.recommendation,
            warnings: recovery.warnings,
          }
        : undefined,
      messages: this.messages.map((message) => ({ ...message })),
    };

    void view.webview.postMessage(message).then(
      () => {
        this.scheduleStateRetry(view, revision);
      },
      () => {
        this.scheduleStateRetry(view, revision);
      },
    );
  }

  private scheduleStateRetry(view: vscode.WebviewView, revision: number): void {
    if (
      this.view !== view ||
      revision !== this.stateRevision ||
      this.acknowledgedRevision >= revision ||
      this.syncRetryCount >= 7
    ) {
      return;
    }

    const delays = [50, 150, 400, 900, 1800, 3000, 5000];
    const delay = delays[this.syncRetryCount] ?? 5000;
    this.syncRetryCount += 1;
    if (this.syncRetry) clearTimeout(this.syncRetry);
    this.syncRetry = setTimeout(() => {
      this.syncRetry = undefined;
      this.postState(revision);
    }, delay);
  }

  private acknowledgeState(revision: number): void {
    if (!Number.isSafeInteger(revision) || revision < 0) return;

    this.acknowledgedRevision = Math.max(this.acknowledgedRevision, revision);
    if (revision !== this.stateRevision) return;

    this.syncRetryCount = 0;
    if (this.syncRetry) clearTimeout(this.syncRetry);
    this.syncRetry = undefined;
  }

  private html(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "agent-chat.js"),
    );

    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta
    http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource};"
  />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    body {
      margin: 0;
      padding: 10px;
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
      font: var(--vscode-font-size) var(--vscode-font-family);
    }
    #recovery {
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      padding: 10px;
      margin-bottom: 10px;
    }
    .muted { color: var(--vscode-descriptionForeground); }
    .strong { font-weight: 600; }
    .row { margin: 3px 0; }
    .status-ok { color: var(--vscode-testing-iconPassed); }
    .status-attention { color: var(--vscode-list-warningForeground); }
    .status-error { color: var(--vscode-list-errorForeground); }
    .status-neutral { color: var(--vscode-foreground); }
    .recommendation {
      margin-top: 8px;
      padding-top: 8px;
      border-top: 1px solid var(--vscode-panel-border);
    }
    #messages {
      display: flex;
      flex-direction: column;
      gap: 8px;
      min-height: 120px;
      max-height: 45vh;
      overflow-y: auto;
      margin-bottom: 10px;
    }
    .message {
      padding: 8px 10px;
      border-radius: 8px;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .user {
      background: var(--vscode-inputOption-activeBackground);
      border: 1px solid var(--vscode-inputOption-activeBorder);
    }
    .assistant {
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-panel-border);
    }
    .activity {
      padding: 4px 8px;
      color: var(--vscode-descriptionForeground);
      font-size: 0.92em;
    }
    #busy-indicator {
      display: none;
      align-items: center;
      gap: 8px;
      min-height: 24px;
      margin: 2px 0 10px;
      color: var(--vscode-descriptionForeground);
    }
    #busy-indicator.visible {
      display: flex;
    }
    .spinner {
      width: 14px;
      height: 14px;
      flex: 0 0 14px;
      border: 2px solid var(--vscode-panel-border);
      border-top-color: var(--vscode-progressBar-background);
      border-radius: 50%;
      animation: llmatic-spin 0.8s linear infinite;
    }
    @keyframes llmatic-spin {
      to { transform: rotate(360deg); }
    }
    textarea {
      width: 100%;
      box-sizing: border-box;
      min-height: 72px;
      resize: vertical;
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border);
      padding: 8px;
      font: inherit;
    }
    .actions {
      display: flex;
      gap: 6px;
      margin-top: 6px;
    }
    button {
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
      border: none;
      padding: 6px 10px;
      cursor: pointer;
    }
    button.secondary {
      color: var(--vscode-button-secondaryForeground);
      background: var(--vscode-button-secondaryBackground);
    }
    button:disabled, textarea:disabled {
      opacity: 0.6;
      cursor: default;
    }
  </style>
</head>
<body>
  <div id="recovery"><span class="muted">Repository context not loaded yet.</span></div>
  <div id="review" style="display:none"></div>
  <div id="messages"></div>
  <div id="busy-indicator" role="status" aria-live="polite">
    <span class="spinner" aria-hidden="true"></span>
    <span id="busy-label">LLMatic is working…</span>
  </div>
  <textarea id="input" placeholder="Ask LLMatic to inspect, continue, implement, fix or explain this repository."></textarea>
  <div class="actions">
    <button id="send">Send</button>
    <button id="continue" class="secondary">Continue recommended</button>
    <button id="refresh" class="secondary">Refresh context</button>
  </div>

  <script src="${scriptUri}"></script>
</body>
</html>`;
  }
}
