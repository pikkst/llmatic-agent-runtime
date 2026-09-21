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
  private review?: CodeReviewReport;
  private readonly messages: ChatMessage[] = [];
  private busy = false;
  private handlers?: AgentChatHandlers;

  public setHandlers(handlers: AgentChatHandlers): void {
    this.handlers = handlers;
  }

  public resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
    };
    view.webview.html = this.html(view.webview);

    view.webview.onDidReceiveMessage(async (message: unknown) => {
      if (!message || typeof message !== "object") return;
      const input = message as Record<string, unknown>;

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

  public setBusy(busy: boolean): void {
    this.busy = busy;
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

    void this.view.webview.postMessage({
      type: "state",
      busy: this.busy,
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
      recovery: this.recovery
        ? {
            repository: this.recovery.repository,
            git: this.recovery.git,
            workflow: this.recovery.workflow
              ? {
                  taskRef: this.recovery.workflow.taskRef,
                  state: this.recovery.workflow.state,
                }
              : undefined,
            task: this.recovery.task
              ? {
                  key: this.recovery.task.key,
                  summary: this.recovery.task.summary,
                  status: this.recovery.task.status.name,
                }
              : undefined,
            nextTask: this.recovery.nextTask
              ? {
                  key: this.recovery.nextTask.key,
                  summary: this.recovery.nextTask.summary,
                }
              : undefined,
            pullRequest: this.recovery.pullRequest
              ? {
                  number: this.recovery.pullRequest.pullRequest.number,
                  ciState: this.recovery.pullRequest.ciState,
                }
              : undefined,
            taskSource: this.recovery.taskSource.selected,
            constitution: {
              explicitRule: this.recovery.constitution.counts.explicitRule,
              approvedRule: this.recovery.constitution.counts.approvedRule,
              inferredConvention: this.recovery.constitution.counts.inferredConvention,
              proposedRule: this.recovery.constitution.counts.proposedRule,
              blocking: this.recovery.constitution.counts.blocking,
            },
            recommendation: this.recovery.recommendation,
            warnings: this.recovery.warnings,
          }
        : undefined,
      messages: this.messages,
    });
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
    const input = document.getElementById("input");
    const send = document.getElementById("send");
    const continueButton = document.getElementById("continue");
    const refresh = document.getElementById("refresh");
    let latestRecovery;

    function textRow(label, value) {
      const row = document.createElement("div");
      row.className = "row";
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
        ),
      );
      recoveryElement.appendChild(textRow("Branch", recovery.git.branch || "detached HEAD"));
      recoveryElement.appendChild(
        textRow("Working tree", recovery.git.clean ? "clean" : "has local changes"),
      );
      recoveryElement.appendChild(textRow("Task source", recovery.taskSource));
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
        ),
      );
      recoveryElement.appendChild(
        textRow(
          "Workflow",
          recovery.workflow
            ? recovery.workflow.taskRef + " · " + recovery.workflow.state
            : "none",
        ),
      );

      if (recovery.task) {
        recoveryElement.appendChild(
          textRow(
            "Recovered task",
            recovery.task.key + " · " + recovery.task.summary + " · " + recovery.task.status,
          ),
        );
      } else if (recovery.nextTask) {
        recoveryElement.appendChild(
          textRow("Next task", recovery.nextTask.key + " · " + recovery.nextTask.summary),
        );
      }

      if (recovery.pullRequest) {
        recoveryElement.appendChild(
          textRow(
            "Open PR",
            "#" + recovery.pullRequest.number + " · CI " + recovery.pullRequest.ciState,
          ),
        );
      }

      const recommendation = document.createElement("div");
      recommendation.className = "recommendation";
      recommendation.appendChild(textRow("Recommended", recovery.recommendation.title));
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
        ),
      );

      for (const finding of review.findings) {
        const item = document.createElement("div");
        item.className = "row";
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
              : "activity";
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
      renderRecovery(state.recovery);
      renderReview(state.review);
      renderMessages(state.messages || []);
      input.disabled = Boolean(state.busy);
      send.disabled = Boolean(state.busy);
      refresh.disabled = Boolean(state.busy);
      if (state.busy) continueButton.disabled = true;
    });
  </script>
</body>
</html>`;
  }
}
