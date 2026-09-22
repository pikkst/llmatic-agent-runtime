import type { WorkflowRun } from "@llmatic/core";
import type { CodeReviewReport } from "@llmatic/review-engine";
import type { TaskRecord } from "@llmatic/task-provider";

export interface PullRequestDraftInput {
  branch?: string;
  base?: string;
  task?: TaskRecord;
  workflow?: WorkflowRun;
  review?: CodeReviewReport;
  changedFiles?: string[];
  extraValidation?: string[];
}

export interface PullRequestDraft {
  title: string;
  body: string;
}

interface ValidationEvidence {
  label: string;
  success: boolean;
  detail: string;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function validationEvidence(
  workflow: WorkflowRun | undefined,
  extra: readonly string[],
): ValidationEvidence[] {
  const latest = new Map<string, ValidationEvidence>();

  for (const checkpoint of workflow?.checkpoints ?? []) {
    if (checkpoint.kind === "CAPABILITY_RUN") {
      latest.set(checkpoint.capability, {
        label: checkpoint.capability,
        success: checkpoint.success,
        detail:
          checkpoint.command +
          " — exit " +
          checkpoint.exitCode +
          " (" +
          checkpoint.durationMs +
          " ms)",
      });
      continue;
    }

    if (
      checkpoint.kind === "ACTION" &&
      (checkpoint.action === "review.complete" ||
        checkpoint.action === "impact.review" ||
        checkpoint.action === "pr.checks")
    ) {
      latest.set(checkpoint.provider + ":" + checkpoint.action, {
        label: checkpoint.provider + " / " + checkpoint.action,
        success: checkpoint.success,
        detail: checkpoint.detail ?? "No detail captured.",
      });
    }
  }

  const evidence = [...latest.values()];
  for (const item of extra) {
    evidence.push({
      label: "additional",
      success: true,
      detail: item,
    });
  }
  return evidence;
}

function checkboxLines(items: readonly string[], empty: string): string[] {
  if (items.length === 0) return ["- [ ] " + empty];
  return items.map((item) => "- [ ] " + item);
}

function bulletLines(items: readonly string[], empty: string): string[] {
  if (items.length === 0) return ["- " + empty];
  return items.map((item) => "- " + item);
}

function titleFor(input: PullRequestDraftInput): string {
  if (input.task) {
    return input.task.key + ": " + input.task.summary;
  }
  if (input.workflow?.taskRef) {
    return input.workflow.taskRef + ": implementation update";
  }
  if (input.branch) {
    return input.branch.replace(/^feature\//, "").replaceAll("-", " ");
  }
  return "Engineering update";
}

function reviewLines(review: CodeReviewReport | undefined): string[] {
  if (!review) {
    return ["- Review evidence not captured yet."];
  }

  const lines = [
    "- Lenses: " + review.lenses.join(", "),
    "- Blocking findings: " + review.blockingCount,
    "- Non-blocking findings: " + review.nonBlockingCount,
    "- Active repository rules considered: " + review.constitution.activeRuleCount,
  ];

  for (const finding of review.findings) {
    lines.push(
      "- " +
        (finding.severity === "blocking" ? "BLOCKING" : "NON-BLOCKING") +
        " [" +
        finding.lens +
        "] " +
        finding.path +
        (finding.line ? ":" + finding.line : "") +
        " — " +
        finding.title +
        (finding.ruleId ? " (" + finding.ruleId + ")" : ""),
    );
  }

  return lines;
}

function securityLines(review: CodeReviewReport | undefined): string[] {
  if (!review) {
    return ["- Security review evidence not captured yet."];
  }

  if (!review.lenses.includes("security")) {
    return ["- Security lens was not run for the latest review."];
  }

  const securityFindings = review.findings.filter(
    (finding) => finding.lens === "security" || finding.category === "security",
  );

  if (securityFindings.length === 0) {
    return ["- Security lens ran with no supported findings."];
  }

  return securityFindings.map(
    (finding) =>
      "- " +
      (finding.severity === "blocking" ? "BLOCKING" : "NON-BLOCKING") +
      " " +
      finding.path +
      (finding.line ? ":" + finding.line : "") +
      " — " +
      finding.title,
  );
}

function architectureLines(review: CodeReviewReport | undefined): string[] {
  if (!review) {
    return ["- Architecture impact evidence not captured yet."];
  }

  if (!review.architectureImpact.baselineDetected) {
    return ["- Living-architecture baseline not detected."];
  }

  if (review.architectureImpact.requiredCount === 0) {
    return ["- No material living-architecture impact was detected."];
  }

  return review.architectureImpact.impacts.map(
    (impact) =>
      "- " +
      (impact.resolved ? "SYNCED" : "BLOCKING") +
      " " +
      impact.area +
      " — " +
      impact.reasons.join(", "),
  );
}

function ruleLines(review: CodeReviewReport | undefined): string[] {
  if (!review) {
    return ["- Repository-rule review evidence not captured yet."];
  }

  const ruledFindings = review.findings.filter((finding) => finding.ruleId);
  const lines = [
    "- Active rules considered: " + review.constitution.activeRuleCount,
    "- Blocking repository rules: " + review.constitution.blockingRuleCount,
    "- Proposed rules awaiting human review: " + review.constitution.proposedRuleCount,
  ];

  if (ruledFindings.length === 0) {
    lines.push("- No concrete finding was linked to an active repository rule.");
  } else {
    for (const finding of ruledFindings) {
      lines.push(
        "- " +
          finding.ruleId +
          " — " +
          finding.title +
          (finding.ruleSource ? " (" + finding.ruleSource + ")" : ""),
      );
    }
  }

  return lines;
}

export function buildPullRequestDraft(input: PullRequestDraftInput): PullRequestDraft {
  const task = input.task;
  const changedFiles = unique(input.changedFiles ?? input.review?.changedFiles ?? []);
  const validation = validationEvidence(input.workflow, input.extraValidation ?? []);
  const validationLines =
    validation.length === 0
      ? ["- Validation evidence not captured yet."]
      : validation.map(
          (item) =>
            "- " + (item.success ? "PASS" : "FAIL") + " " + item.label + " — " + item.detail,
        );

  const taskReference = task?.webUrl
    ? task.key + " — " + task.webUrl
    : (task?.key ?? input.workflow?.taskRef ?? "Not linked");

  const body = [
    "## Why",
    "",
    task
      ? task.summary + (task.description ? "\n\n" + task.description : "")
      : "Task/problem context has not been captured yet.",
    "",
    "## Task",
    "",
    "- Reference: " + taskReference,
    "- Status: " + (task?.status.name ?? input.workflow?.state ?? "not captured"),
    "- Branch: " + (input.branch ?? "not captured"),
    "- Base: " + (input.base ?? "not captured"),
    "",
    "## What changed",
    "",
    ...bulletLines(changedFiles, "Changed-file evidence not captured yet."),
    "",
    "## Acceptance criteria",
    "",
    ...checkboxLines(task?.acceptanceCriteria ?? [], "Acceptance criteria not captured."),
    "",
    "## Definition of Done",
    "",
    ...checkboxLines(task?.definitionOfDone ?? [], "Definition of Done not captured."),
    "",
    "## Validation evidence",
    "",
    ...validationLines,
    "",
    "## Review evidence",
    "",
    ...reviewLines(input.review),
    "",
    "## Security",
    "",
    ...securityLines(input.review),
    "",
    "## Architecture / contracts",
    "",
    ...architectureLines(input.review),
    "",
    "## Repository rules",
    "",
    ...ruleLines(input.review),
    "",
    "## Risk / rollback",
    "",
    "- Risk and rollback details must be added when deployment, schema, data, auth, or operational behavior is affected.",
    "- No unsupported rollback claim is generated automatically.",
    "",
  ].join("\n");

  return {
    title: titleFor(input),
    body,
  };
}
