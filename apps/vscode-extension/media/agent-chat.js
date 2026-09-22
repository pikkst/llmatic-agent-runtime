(() => {
  "use strict";

  let vscode;

  try {
    vscode = acquireVsCodeApi();
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
      if (typeof state.revision === "number") {
        vscode.postMessage({ type: "state-applied", revision: state.revision });
      }
    });

    vscode.postMessage({ type: "ready" });
    for (const delay of [150, 500, 1200]) {
      setTimeout(() => {
        if (!receivedState) vscode.postMessage({ type: "ready" });
      }, delay);
    }

    document.documentElement.dataset.llmaticAgentChatReady = "true";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const recoveryElement = document.getElementById("recovery");
    if (recoveryElement) {
      recoveryElement.textContent = "Agent Chat client failed to start: " + message;
      recoveryElement.className = "status-error";
    }

    try {
      vscode?.postMessage({ type: "client-error", message });
    } catch {
      // The VS Code API itself may be unavailable if bootstrap failed very early.
    }

    console.error("LLMatic Agent Chat bootstrap failed:", error);
  }
})();
