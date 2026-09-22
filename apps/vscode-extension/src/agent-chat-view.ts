import { randomBytes } from "node:crypto";
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
  private syncRetryCount = 0;
  private syncRetry?: ReturnType<typeof setTimeout>;
  private handlers?: AgentChatHandlers;

  public setHandlers(handlers: AgentChatHandlers): void {
    this.handlers = handlers;
  }

  public setRecoverySource(source: () => WorkspaceRecovery | undefined): void {
    this.recoverySource = source;
    this.sync();
  }

  private currentRecovery(): WorkspaceRecovery | undefined {
    return this.recoverySource?.() ?? this.recovery;
  }

  public resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
    };

    // Register the extension-side receiver before assigning HTML. The webview
    // posts a ready handshake during script startup, and a fast webview could
    // otherwise beat listener registration and remain permanently unhydrated.
    view.webview.onDidReceiveMessage(async (message: unknown) => {
      if (!message || typeof message !== "object") return;
      const input = message as Record<string, unknown>;

      if (input.type === "ready") {
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

    const view = this.view;
    const recovery = this.currentRecovery();
    const message = {
      type: "state",
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
      (delivered) => {
        if (this.view !== view) return;
        if (delivered) {
          this.syncRetryCount = 0;
          if (this.syncRetry) clearTimeout(this.syncRetry);
          this.syncRetry = undefined;
          return;
        }

        if (this.syncRetryCount >= 5) return;
        const delays = [50, 150, 400, 900, 1800];
        const delay = delays[this.syncRetryCount] ?? 1800;
        this.syncRetryCount += 1;
        if (this.syncRetry) clearTimeout(this.syncRetry);
        this.syncRetry = setTimeout(() => {
          this.syncRetry = undefined;
          this.sync();
        }, delay);
      },
      () => {
        if (this.view !== view || this.syncRetryCount >= 5) return;
        this.syncRetryCount += 1;
        if (this.syncRetry) clearTimeout(this.syncRetry);
        this.syncRetry = setTimeout(() => {
          this.syncRetry = undefined;
          this.sync();
        }, 250);
      },
    );
  }

  private html(webview: vscode.Webview): string {
    const nonce = randomBytes(16).toString("base64");

    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta
    http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';"
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

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const recoveryElement = document.getElementById("recovery");
    const reviewElement = document.getElementById("review");
    const messagesElement = document.getElementById("messages");
    const busyIndicator = document.getElementById("busy-indicator");
    const busyLabel = document.getElementById("busy-label");
    const input = document.getElementById("input");
    const send = document.getElementById("send");
    const continueButton = document.getElementById("continue");
    const refresh = document.getElementById("refresh");
    let latestRecovery;
    let receivedState = false;

    function textRow(label, value, status = "neutral") {
      const row = document.createElement("div");
      row.className = "row status-" + status;
      const strong = document.createElement("span");
      strong.className = "strong";
      strong.textContent = label + ": ";
      row.appendChild(strong);
      row.appendChild(document.createTextNode(value));
      return row;
    }

    function renderRecovery(recovery) {
      recoveryElement.textContent = "";
      latestRecovery = recovery;

      if (!recovery) {
        const empty = document.createElement("span");
        empty.className = "muted";
        empty.textContent = "Repository context not loaded yet.";
        recoveryElement.appendChild(empty);
        continueButton.disabled = true;
        return;
      }

      recoveryElement.appendChild(
        textRow(
          "Repository map",
          recovery.repository.fileCount +
            " files · " +
            recovery.repository.symbolCount +
            " symbols · " +
            recovery.repository.importCount +
            " imports",
          recovery.repository.fileCount > 0 ? "ok" : "attention",
        ),
      );
      recoveryElement.appendChild(
        textRow("Branch", recovery.git.branch || "detached HEAD", "neutral"),
      );
      recoveryElement.appendChild(
        textRow(
          "Working tree",
          recovery.git.clean ? "clean" : "has local changes",
          recovery.git.clean ? "ok" : "attention",
        ),
      );
      recoveryElement.appendChild(textRow("Task source", recovery.taskSource, "ok"));
      recoveryElement.appendChild(
        textRow(
          "Repository rules",
          recovery.constitution.explicitRule +
            " explicit · " +
            recovery.constitution.approvedRule +
            " approved · " +
            recovery.constitution.inferredConvention +
            " inferred · " +
            recovery.constitution.proposedRule +
            " proposed",
          recovery.constitution.proposedRule > 0 ? "attention" : "ok",
        ),
      );
      recoveryElement.appendChild(
        textRow(
          "Workflow",
          recovery.workflow
            ? recovery.workflow.taskRef + " · " + recovery.workflow.state
            : "none",
          recovery.workflow ? "attention" : "ok",
        ),
      );

      if (recovery.task) {
        recoveryElement.appendChild(
          textRow(
            "Recovered task",
            recovery.task.key + " · " + recovery.task.summary + " · " + recovery.task.status,
            "attention",
          ),
        );
      } else if (recovery.nextTask) {
        recoveryElement.appendChild(
          textRow(
            "Next task",
            recovery.nextTask.key + " · " + recovery.nextTask.summary,
            "attention",
          ),
        );
      }

      if (recovery.pullRequest) {
        recoveryElement.appendChild(
          textRow(
            "Open PR",
            "#" + recovery.pullRequest.number + " · CI " + recovery.pullRequest.ciState,
            recovery.pullRequest.ciState === "failing" ||
              recovery.pullRequest.ciState === "cancelled"
              ? "error"
              : recovery.pullRequest.ciState === "passing"
                ? "ok"
                : "attention",
          ),
        );
      }

      const recommendation = document.createElement("div");
      recommendation.className = "recommendation";
      recommendation.appendChild(
        textRow(
          "Recommended",
          recovery.recommendation.title,
          recovery.recommendation.action === "fix_pr"
            ? "error"
            : recovery.recommendation.action === "ask_goal"
              ? "ok"
              : "attention",
        ),
      );
      const detail = document.createElement("div");
      detail.className = "muted";
      detail.textContent = recovery.recommendation.detail;
      recommendation.appendChild(detail);
      recoveryElement.appendChild(recommendation);
      continueButton.disabled = false;
    }

    function renderReview(review) {
      reviewElement.textContent = "";

      if (!review) {
        reviewElement.style.display = "none";
        return;
      }

      reviewElement.style.display = "block";
      reviewElement.style.border = "1px solid var(--vscode-panel-border)";
      reviewElement.style.borderRadius = "6px";
      reviewElement.style.padding = "10px";
      reviewElement.style.marginBottom = "10px";

      reviewElement.appendChild(
        textRow(
          "Latest review",
          review.blockingCount +
            " blocking · " +
            review.nonBlockingCount +
            " non-blocking · " +
            review.lenses.join(", "),
          review.blockingCount > 0
            ? "error"
            : review.nonBlockingCount > 0
              ? "attention"
              : "ok",
        ),
      );

      for (const finding of review.findings) {
        const item = document.createElement("div");
        item.className =
          "row " +
          (finding.severity === "blocking" ? "status-error" : "status-attention");
        item.textContent =
          (finding.severity === "blocking" ? "⛔ " : "• ") +
          "[" +
          finding.lens +
          "] " +
          finding.title +
          " — " +
          finding.path +
          (finding.line ? ":" + finding.line : "") +
          (finding.ruleId ? " · " + finding.ruleId : "");
        reviewElement.appendChild(item);
      }
    }

    function renderMessages(messages) {
      messagesElement.textContent = "";
      for (const message of messages) {
        const item = document.createElement("div");
        item.className =
          message.role === "user"
            ? "message user"
            : message.role === "assistant"
              ? "message assistant"
              : "activity " +
                (message.success === true
                  ? "status-ok"
                  : message.success === false
                    ? "status-error"
                    : "status-neutral");
        item.textContent =
          message.role === "user"
            ? "You\n" + message.content
            : message.role === "assistant"
              ? "LLMatic\n" + message.content
              : message.content;
        messagesElement.appendChild(item);
      }
      messagesElement.scrollTop = messagesElement.scrollHeight;
    }

    function submit(text) {
      const value = text.trim();
      if (!value) return;
      vscode.postMessage({ type: "send", text: value });
      input.value = "";
    }

    send.addEventListener("click", () => submit(input.value));
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        submit(input.value);
      }
    });
    refresh.addEventListener("click", () => vscode.postMessage({ type: "refresh" }));
    continueButton.addEventListener("click", () => {
      if (!latestRecovery) return;
      vscode.postMessage({ type: "continue" });
    });

    window.addEventListener("message", (event) => {
      const state = event.data;
      if (!state || state.type !== "state") return;
      receivedState = true;
      renderRecovery(state.recovery);
      renderReview(state.review);
      renderMessages(state.messages || []);
      const busy = Boolean(state.busy);
      input.disabled = busy;
      send.disabled = busy;
      refresh.disabled = busy;
      busyIndicator.classList.toggle("visible", busy);
      busyLabel.textContent = state.busyLabel || "LLMatic is working…";
      send.textContent = busy ? "Working…" : "Send";
      if (busy) continueButton.disabled = true;
    });

    vscode.postMessage({ type: "ready" });
    for (const delay of [150, 500, 1200]) {
      setTimeout(() => {
        if (!receivedState) vscode.postMessage({ type: "ready" });
      }, delay);
    }
  </script>
</body>
</html>`;
  }
}
