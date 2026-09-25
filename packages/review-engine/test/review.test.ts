import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  WorkflowStateStore,
  createDefaultConfig,
  startWorkflow,
  transitionWorkflow,
  type RepositoryDetection,
} from "@llmatic/core";
import {
  activeRepositoryRules,
  buildRepositoryConstitution,
} from "@llmatic/repository-constitution";
import type {
  GatewayChatClient,
  GatewayChatRequest,
  GatewayChatResponse,
} from "@llmatic/gateway-client";
import {
  listChangedFiles,
  runCodeReview,
  runExternalPullRequestReview,
  runReviewFixLoop,
  type ReviewActivityEvent,
} from "../src/review.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

function configFor(root: string) {
  const detection: RepositoryDetection = {
    root,
    git: true,
    packageJson: true,
    packageManager: "pnpm",
    technologies: [],
    capabilities: [],
  };
  return createDefaultConfig(detection);
}

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "llmatic-review-"));
  temporaryDirectories.push(root);

  if (spawnSync("git", ["init"], { cwd: root, encoding: "utf8", shell: false }).status !== 0) {
    throw new Error("git init failed");
  }
  spawnSync("git", ["config", "user.email", "test@example.test"], { cwd: root });
  spawnSync("git", ["config", "user.name", "LLMatic Test"], { cwd: root });

  await mkdir(join(root, "src"));
  await writeFile(join(root, "src", "value.ts"), "export const value = 1;\n");
  await writeFile(join(root, ".env"), "SECRET=yes\n");
  spawnSync("git", ["add", "."], { cwd: root });
  if (spawnSync("git", ["commit", "-m", "initial"], { cwd: root }).status !== 0) {
    throw new Error("git commit failed");
  }

  await writeFile(join(root, "src", "value.ts"), "export const value = 2;\n");
  await writeFile(join(root, ".env"), "SECRET=changed\n");
  return root;
}

class ScriptedGateway implements GatewayChatClient {
  public readonly requests: GatewayChatRequest[] = [];
  public readonly modelFailures: Array<{
    model: string;
    responseModel?: string;
    task?: string;
    reason: string;
  }> = [];
  public readonly modelSuccesses: Array<{
    model: string;
    responseModel?: string;
    task?: string;
  }> = [];
  public constructor(private readonly responses: GatewayChatResponse[]) {}
  public async createChatCompletion(request: GatewayChatRequest): Promise<GatewayChatResponse> {
    this.requests.push(request);
    const response = this.responses.shift();
    if (!response) throw new Error("No scripted review response remains.");
    return response;
  }
  public reportModelFailure(feedback: {
    model: string;
    responseModel?: string;
    task?: string;
    reason: string;
  }): void {
    this.modelFailures.push(feedback);
  }
  public reportModelSuccess(feedback: {
    model: string;
    responseModel?: string;
    task?: string;
  }): void {
    this.modelSuccesses.push(feedback);
  }
}

function response(
  content: string | null,
  toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>,
  model = "kilo-auto/free",
): GatewayChatResponse {
  return {
    id: "review",
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content,
          tool_calls: toolCalls?.map((call) => ({
            id: call.id,
            type: "function",
            function: {
              name: call.name,
              arguments: JSON.stringify(call.arguments),
            },
          })),
        },
      },
    ],
  };
}

async function moveToCodeReview(store: WorkflowStateStore): Promise<void> {
  await transitionWorkflow(store, "TASK_VALIDATED");
  await transitionWorkflow(store, "REPO_ANALYZED");
  await transitionWorkflow(store, "BRANCH_CREATED");
  await transitionWorkflow(store, "IMPLEMENTING");
  await transitionWorkflow(store, "LOCAL_VALIDATION");
  await transitionWorkflow(store, "CODE_REVIEW");
}

describe("review engine", () => {
  it("filters sensitive changed paths from review context", async () => {
    const root = await repository();
    expect(listChangedFiles(root)).toEqual(["src/value.ts"]);
  });

  it("reviews an external pull request without changing workflow state", async () => {
    const root = await repository();
    const config = configFor(root);
    const events: ReviewActivityEvent[] = [];
    const gateway = new ScriptedGateway([
      response(
        JSON.stringify({
          summary: "One concrete external PR defect.",
          findings: [
            {
              severity: "blocking",
              category: "correctness",
              basis: "defect",
              title: "Unexpected exported value",
              path: "src/value.ts",
              line: 1,
              evidence: "The PR patch changes the exported value from 1 to 2.",
              recommendation: "Confirm the contract or restore the expected value.",
            },
          ],
        }),
      ),
    ]);

    const report = await runExternalPullRequestReview({
      root,
      config,
      gateway,
      lenses: ["general"],
      onActivity: (event) => events.push(event),
      material: {
        reference: "42",
        headRefOid: "head-42",
        title: "Change value",
        body: "Please review this change.",
        authorLogin: "contributor",
        ciState: "passing",
        changedFiles: ["src/value.ts"],
        diff: "diff --git a/src/value.ts b/src/value.ts\n--- a/src/value.ts\n+++ b/src/value.ts\n@@ -1 +1 @@\n-export const value = 1;\n+export const value = 2;\n",
        diffTruncated: false,
        reviews: [{ body: "ANCHOR: truncated is definitely a blocking bug" }],
        comments: [{ body: "ANCHOR: change the test string to optional chaining" }],
        reviewThreads: [
          {
            path: ".env",
            resolved: false,
            outdated: false,
            comments: [{ body: "SECRET=do-not-send" }],
          },
        ],
      },
    });

    expect(report.source).toBe("external_pull_request");
    expect(report.reference).toBe("42");
    expect(report.headRefOid).toBe("head-42");
    expect(report.coverage).toBe("complete");
    expect(report.unreviewedFiles).toEqual([]);
    expect(report.blockingCount).toBe(1);
    expect(gateway.requests).toHaveLength(1);
    expect(gateway.requests[0]?.tools).toBeUndefined();
    expect(gateway.requests[0]?.tool_choice).toBeUndefined();
    expect(gateway.requests[0]?.response_format).toEqual({ type: "json_object" });
    expect(gateway.requests[0]?.max_tokens).toBe(6000);
    expect(JSON.stringify(gateway.requests[0]?.messages[1])).toContain("+export const value = 2;");
    const system = JSON.stringify(gateway.requests[0]?.messages[0]);
    expect(system).toContain("external pull request");
    expect(system).toContain("untrusted project data");
    expect(system).toContain("Absence from the current packet is NOT evidence");
    expect(JSON.stringify(gateway.requests[0]?.messages[1])).not.toContain("SECRET=do-not-send");
    expect(JSON.stringify(gateway.requests[0]?.messages[1])).not.toContain(".env");
    expect(JSON.stringify(gateway.requests[0]?.messages[1])).not.toContain("ANCHOR:");
    expect(system).toContain("Prior human/bot review comments are intentionally excluded");
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "constitution-start",
        "constitution-complete",
        "coverage",
        "lens-start",
        "model-request",
        "model-response",
        "lens-batch-start",
        "lens-complete",
        "architecture-start",
        "architecture-complete",
        "complete",
      ]),
    );
    expect(
      events.find(
        (event): event is Extract<ReviewActivityEvent, { type: "model-response" }> =>
          event.type === "model-response",
      )?.durationMs,
    ).toBeGreaterThanOrEqual(0);
  });

  it("truncates external file packets only at complete source-line boundaries", async () => {
    const root = await repository();
    const config = configFor(root);
    const gateway = new ScriptedGateway([
      response(
        JSON.stringify({
          summary: "No concrete finding.",
          findings: [],
        }),
      ),
    ]);

    const prefix =
      "diff --git a/src/value.ts b/src/value.ts\n--- a/src/value.ts\n+++ b/src/value.ts\n@@ -1 +1,3 @@\n-export const value = 1;\n";
    const padding = "+" + "x".repeat(9_000) + "\n";
    const dangerousLine = "+return fallbackMs;\n";

    await runExternalPullRequestReview({
      root,
      config,
      gateway,
      lenses: ["general"],
      material: {
        reference: "42",
        headRefOid: "head-42",
        title: "Large changed file",
        body: "",
        ciState: "passing",
        changedFiles: ["src/value.ts"],
        diff: prefix + padding + dangerousLine,
        diffTruncated: false,
      },
    });

    const packet = JSON.stringify(gateway.requests[0]?.messages[1]);
    expect(packet).toContain("FILE DIFF TRUNCATED");
    expect(packet).toContain("must never be treated as evidence");
    expect(packet).not.toContain("return fallbac");
    expect(packet).not.toContain("return fallbackMs");
  });

  it("filters nice-to-have maintainability suggestions from external review findings", async () => {
    const root = await repository();
    const config = configFor(root);
    const gateway = new ScriptedGateway([
      response(
        JSON.stringify({
          summary: "Optional cleanup idea.",
          findings: [
            {
              severity: "non_blocking",
              category: "maintainability",
              basis: "defect",
              title: "Extract helper for readability",
              path: "src/value.ts",
              line: 1,
              side: "RIGHT",
              evidence: "The changed line could be wrapped in a helper.",
              recommendation: "Extract a helper function.",
            },
          ],
        }),
      ),
    ]);

    const report = await runExternalPullRequestReview({
      root,
      config,
      gateway,
      lenses: ["general"],
      material: {
        reference: "42",
        headRefOid: "head-42",
        title: "Avoid review scope expansion",
        body: "",
        ciState: "passing",
        changedFiles: ["src/value.ts"],
        diff: "diff --git a/src/value.ts b/src/value.ts\n--- a/src/value.ts\n+++ b/src/value.ts\n@@ -1 +1 @@\n-export const value = 1;\n+export const value = 2;\n",
        diffTruncated: false,
      },
    });

    expect(report.findings).toEqual([]);
    expect(report.summary).toContain("0 concrete defect/rule violation(s)");
  });

  it("drops impossible DoD findings without invoking report repair when acceptance evidence is absent", async () => {
    const root = await repository();
    const config = configFor(root);
    const events: ReviewActivityEvent[] = [];
    const gateway = new ScriptedGateway([
      response(
        JSON.stringify({
          summary: "Reliability improvements reviewed.",
          findings: [
            {
              severity: "non_blocking",
              category: "reliability",
              basis: "dod",
              title: "Timeout increase improves resilience",
              path: "src/value.ts",
              evidence: "The timeout was increased.",
              recommendation: "No action needed.",
            },
          ],
        }),
        undefined,
        "liquid/lfm-2.5-2.6b:free",
      ),
    ]);

    const report = await runExternalPullRequestReview({
      root,
      config,
      gateway,
      lenses: ["general"],
      onActivity: (event) => events.push(event),
      material: {
        reference: "42",
        headRefOid: "head-42",
        title: "No documented acceptance evidence",
        body: "",
        ciState: "passing",
        changedFiles: ["src/value.ts"],
        diff: "diff --git a/src/value.ts b/src/value.ts\n--- a/src/value.ts\n+++ b/src/value.ts\n@@ -1 +1 @@\n-export const value = 1;\n+export const value = 2;\n",
        diffTruncated: false,
      },
    });

    expect(gateway.requests).toHaveLength(1);
    expect(gateway.modelFailures).toEqual([]);
    expect(gateway.modelSuccesses).toEqual([
      {
        model: "liquid/lfm-2.5-2.6b:free",
        responseModel: "liquid/lfm-2.5-2.6b:free",
        task: "review_general",
      },
    ]);
    expect(events).not.toContainEqual(
      expect.objectContaining({
        type: "report-repair",
      }),
    );
    expect(report.reviewStatus).toBe("complete");
    expect(report.findings).toEqual([]);
    expect(report.summary).toContain("0 documented DoD/acceptance violation(s)");
  });

  it("drops positive DoD observations before schema repair even when Jira evidence exists", async () => {
    const root = await repository();
    const config = configFor(root);
    const events: ReviewActivityEvent[] = [];
    const gateway = new ScriptedGateway([
      response(
        JSON.stringify({
          summary: "The acceptance requirement is covered.",
          findings: [
            {
              severity: "blocking",
              category: "correctness",
              basis: "dod",
              title: "Deterministic adversarial regression suite implemented",
              path: "src/value.ts",
              evidence: "The changed test satisfies the linked Jira acceptance criterion.",
              recommendation: "No modification needed.",
            },
          ],
        }),
        undefined,
        "liquid/lfm-2.5-2.6b:free",
      ),
    ]);

    const report = await runExternalPullRequestReview({
      root,
      config,
      gateway,
      lenses: ["general"],
      onActivity: (event) => events.push(event),
      material: {
        reference: "213",
        headRefOid: "head-213",
        title: "KT-123: adversarial regression suite",
        body: "",
        ciState: "passing",
        changedFiles: ["src/value.ts"],
        diff: "diff --git a/src/value.ts b/src/value.ts\n--- a/src/value.ts\n+++ b/src/value.ts\n@@ -1 +1 @@\n-export const value = 1;\n+export const value = 2;\n",
        diffTruncated: false,
        documentedAcceptanceEvidence: [
          "[Jira KT-123 AC] Adversarial suite runs deterministically in CI",
        ],
        acceptanceEvidenceSource: "Jira KT-123",
      },
    });

    expect(gateway.requests).toHaveLength(1);
    expect(events).not.toContainEqual(expect.objectContaining({ type: "report-repair" }));
    expect(report.findings).toEqual([]);
    expect(report.blockingCount).toBe(0);
    expect(report.reviewStatus).toBe("complete");
  });

  it("accepts Jira-backed DoD evidence even when the PR body has no acceptance section", async () => {
    const root = await repository();
    const config = configFor(root);
    const dodRef = "[Jira KT-121 AC] Strict output rejects unknown references";
    const gateway = new ScriptedGateway([
      response(
        JSON.stringify({
          summary: "Jira acceptance gap.",
          findings: [
            {
              severity: "blocking",
              category: "correctness",
              basis: "dod",
              title: "Unknown references are still accepted",
              path: "src/value.ts",
              evidence: "The changed validator accepts an unknown source identifier.",
              recommendation:
                "Reject source identifiers that are not present in the grounded input.",
              dod_ref: dodRef,
            },
          ],
        }),
      ),
    ]);

    const report = await runExternalPullRequestReview({
      root,
      config,
      gateway,
      lenses: ["general"],
      material: {
        reference: "211",
        headRefOid: "head-211",
        title: "KT-121: strict output firewall",
        body: "",
        ciState: "passing",
        changedFiles: ["src/value.ts"],
        diff: "diff --git a/src/value.ts b/src/value.ts\n--- a/src/value.ts\n+++ b/src/value.ts\n@@ -1 +1 @@\n-export const acceptsUnknown = false;\n+export const acceptsUnknown = true;\n",
        diffTruncated: false,
        documentedAcceptanceEvidence: [dodRef],
        acceptanceEvidenceSource: "Jira KT-121",
      },
    });

    expect(report.reviewStatus).toBe("complete");
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]).toMatchObject({
      basis: "dod",
      dodRef,
      severity: "blocking",
    });
  });

  it("marks the review partial instead of claiming DoD coverage when Jira evidence cannot be loaded", async () => {
    const root = await repository();
    const config = configFor(root);
    const gateway = new ScriptedGateway([
      response(
        JSON.stringify({
          summary: "Code review completed without a concrete defect.",
          findings: [],
        }),
      ),
    ]);

    const report = await runExternalPullRequestReview({
      root,
      config,
      gateway,
      lenses: ["general"],
      material: {
        reference: "211",
        headRefOid: "head-211",
        title: "KT-121: strict output firewall",
        body: "",
        ciState: "pending",
        changedFiles: ["src/value.ts"],
        diff: "diff --git a/src/value.ts b/src/value.ts\n--- a/src/value.ts\n+++ b/src/value.ts\n@@ -1 +1 @@\n-export const value = 1;\n+export const value = 2;\n",
        diffTruncated: false,
        acceptanceEvidenceSource: "Jira KT-121",
        acceptanceEvidenceUnavailableReason: "could not load KT-121 acceptance criteria",
      },
    });

    expect(report.reviewStatus).toBe("partial");
    expect(report.findings).toEqual([]);
    expect(report.summary).toContain("DoD/acceptance verification unavailable");
    expect(report.summary).not.toContain("0 documented DoD/acceptance violation(s)");
  });

  it("keeps only DoD findings backed by documented PR acceptance evidence", async () => {
    const root = await repository();
    const config = configFor(root);
    const gateway = new ScriptedGateway([
      response(
        JSON.stringify({
          summary: "Acceptance gate review.",
          findings: [
            {
              severity: "blocking",
              category: "tests",
              basis: "dod",
              title: "Required regression test is missing",
              path: "src/value.ts",
              evidence: "The PR changes behavior but does not add the required regression test.",
              recommendation: "Add the regression test required by the acceptance criterion.",
              dod_ref: "Add regression coverage for the changed behavior",
            },
            {
              severity: "blocking",
              category: "tests",
              basis: "dod",
              title: "Invented acceptance requirement",
              path: "src/value.ts",
              evidence: "No benchmark was added.",
              recommendation: "Add a benchmark.",
              dod_ref: "Add a performance benchmark",
            },
          ],
        }),
      ),
    ]);

    const report = await runExternalPullRequestReview({
      root,
      config,
      gateway,
      lenses: ["general"],
      material: {
        reference: "42",
        headRefOid: "head-42",
        title: "DoD-backed review",
        body: "## Acceptance Criteria\n- Add regression coverage for the changed behavior\n",
        ciState: "passing",
        changedFiles: ["src/value.ts"],
        diff: "diff --git a/src/value.ts b/src/value.ts\n--- a/src/value.ts\n+++ b/src/value.ts\n@@ -1 +1 @@\n-export const value = 1;\n+export const value = 2;\n",
        diffTruncated: false,
      },
    });

    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]).toMatchObject({
      basis: "dod",
      dodRef: "Add regression coverage for the changed behavior",
      title: "Required regression test is missing",
    });
    expect(report.summary).toContain("1 documented DoD/acceptance violation(s)");
  });

  it("rejects line-less missing-work DoD findings when external diff coverage is partial", async () => {
    const root = await repository();
    const config = configFor(root);
    const gateway = new ScriptedGateway([
      response(
        JSON.stringify({
          summary: "Missing-work claim from partial evidence.",
          findings: [
            {
              severity: "blocking",
              category: "tests",
              basis: "dod",
              title: "Required regression test is missing",
              path: "src/value.ts",
              evidence: "The bounded packet does not show the required regression test.",
              recommendation: "Add the regression test.",
              dod_ref: "Add regression coverage for the changed behavior",
            },
          ],
        }),
      ),
    ]);

    const report = await runExternalPullRequestReview({
      root,
      config,
      gateway,
      lenses: ["general"],
      material: {
        reference: "42",
        headRefOid: "head-42",
        title: "Partial DoD evidence",
        body: "## Acceptance Criteria\n- Add regression coverage for the changed behavior\n",
        ciState: "passing",
        changedFiles: ["src/value.ts", "test/value.test.ts"],
        diff: "diff --git a/src/value.ts b/src/value.ts\n--- a/src/value.ts\n+++ b/src/value.ts\n@@ -1 +1 @@\n-export const value = 1;\n+export const value = 2;\n",
        diffTruncated: true,
      },
    });

    expect(report.coverage).toBe("partial");
    expect(report.findings).toEqual([]);
    expect(report.summary).toContain("0 documented DoD/acceptance violation(s)");
  });

  it("suppresses a cross-batch typed-member absence claim contradicted by the exact PR head", async () => {
    const root = await repository();
    const config = configFor(root);
    const gateway = new ScriptedGateway([
      response(
        JSON.stringify({
          summary: "First bounded batch review.",
          findings: [
            {
              severity: "blocking",
              category: "correctness",
              basis: "defect",
              title: "Trust boundary references a non-existent finding summary field",
              path: "src/a-geminiServer.ts",
              line: 1,
              side: "RIGHT",
              evidence:
                "ExplanationFindingInput type does not have a summary field, so evidence.findings[].summary is invalid.",
              recommendation: "Remove evidence.findings[].summary from the trust boundary.",
            },
          ],
        }),
      ),
      response(
        JSON.stringify({
          summary: "Second bounded batch review.",
          findings: [],
        }),
      ),
    ]);
    const changedFiles = [
      "src/a-geminiServer.ts",
      "src/b.ts",
      "src/c.ts",
      "src/d.ts",
      "src/e.ts",
      "src/f.ts",
      "src/z-types.ts",
    ];
    const diff =
      "diff --git a/src/a-geminiServer.ts b/src/a-geminiServer.ts\n" +
      "--- a/src/a-geminiServer.ts\n" +
      "+++ b/src/a-geminiServer.ts\n" +
      "@@ -1 +1 @@\n" +
      "-export const trustBoundary = [];\n" +
      '+export const trustBoundary = ["evidence.findings[].summary"];\n' +
      ["src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts", "src/f.ts"]
        .map(
          (path) =>
            "diff --git a/" +
            path +
            " b/" +
            path +
            "\n--- a/" +
            path +
            "\n+++ b/" +
            path +
            "\n@@ -1 +1 @@\n-export const value = 1;\n+export const value = 2;\n",
        )
        .join("") +
      "diff --git a/src/z-types.ts b/src/z-types.ts\n" +
      "--- a/src/z-types.ts\n" +
      "+++ b/src/z-types.ts\n" +
      "@@ -1,4 +1,5 @@\n" +
      " export interface ExplanationFindingInput {\n" +
      "+  readonly findingId: string;\n" +
      "   readonly code: string;\n" +
      "   readonly summary?: string;\n" +
      " }\n";
    const reads: string[] = [];

    const report = await runExternalPullRequestReview({
      root,
      config,
      gateway,
      readFile: async (path) => {
        reads.push(path);
        return {
          path,
          content:
            path === "src/z-types.ts"
              ? "export interface ExplanationFindingInput {\n  readonly findingId: string;\n  readonly code: string;\n  readonly summary?: string;\n}\n"
              : "",
        };
      },
      lenses: ["general"],
      material: {
        reference: "210",
        headRefOid: "head-210",
        title: "Grounded explanation input",
        body: "",
        ciState: "pending",
        changedFiles,
        diff,
        diffTruncated: false,
      },
    });

    expect(gateway.requests).toHaveLength(2);
    expect(reads).toContain("src/z-types.ts");
    expect(report.reviewStatus).toBe("complete");
    expect(report.findings).toEqual([]);
    expect(report.summary).toContain("0 concrete defect/rule violation(s)");
  });

  it("keeps a typed-member absence finding when the diff positively removes that member", async () => {
    const root = await repository();
    const config = configFor(root);
    const gateway = new ScriptedGateway([
      response(
        JSON.stringify({
          summary: "Contract regression.",
          findings: [
            {
              severity: "blocking",
              category: "correctness",
              basis: "defect",
              title: "ExplanationFindingInput lost the summary field",
              path: "src/use.ts",
              line: 1,
              side: "RIGHT",
              evidence:
                "ExplanationFindingInput type does not have a summary field after this patch, while the changed consumer still references it.",
              recommendation: "Restore the summary field or update the consumer contract.",
            },
          ],
        }),
      ),
    ]);
    const diff =
      "diff --git a/src/use.ts b/src/use.ts\n" +
      "--- a/src/use.ts\n" +
      "+++ b/src/use.ts\n" +
      "@@ -1 +1 @@\n" +
      '-export const path = "evidence.findings";\n' +
      '+export const path = "evidence.findings[].summary";\n' +
      "diff --git a/src/types.ts b/src/types.ts\n" +
      "--- a/src/types.ts\n" +
      "+++ b/src/types.ts\n" +
      "@@ -1,4 +1,3 @@\n" +
      " export interface ExplanationFindingInput {\n" +
      "-  readonly summary?: string;\n" +
      "   readonly code: string;\n" +
      " }\n";

    const report = await runExternalPullRequestReview({
      root,
      config,
      gateway,
      lenses: ["general"],
      material: {
        reference: "43",
        headRefOid: "head-43",
        title: "Remove summary contract",
        body: "",
        ciState: "pending",
        changedFiles: ["src/use.ts", "src/types.ts"],
        diff,
        diffTruncated: false,
      },
    });

    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]?.title).toBe("ExplanationFindingInput lost the summary field");
    expect(report.blockingCount).toBe(1);
  });

  it("suppresses a duplicate union-member claim contradicted by the exact PR head", async () => {
    const root = await repository();
    const config = configFor(root);
    const gateway = new ScriptedGateway([
      response(
        JSON.stringify({
          summary: "Potential duplicate union member.",
          findings: [
            {
              severity: "non_blocking",
              category: "correctness",
              basis: "defect",
              title: "Duplicate entry in ExplanationOutputValidationReason union type",
              path: "src/outputValidation.ts",
              line: 2,
              side: "RIGHT",
              evidence:
                'The ExplanationOutputValidationReason union type contains "UNSUPPORTED_SEMANTIC_CLAIM" twice.',
              recommendation: "Remove the duplicate union member.",
            },
          ],
        }),
      ),
    ]);
    const reads: string[] = [];

    const report = await runExternalPullRequestReview({
      root,
      config,
      gateway,
      readFile: async (path) => {
        reads.push(path);
        return {
          path,
          content:
            'export type ExplanationOutputValidationReason =\n  | "UNSUPPORTED_SEMANTIC_CLAIM"\n  | "UNSUPPORTED_CURRENT_FACT_CLAIM";\n',
        };
      },
      lenses: ["bug_hunter"],
      material: {
        reference: "213",
        headRefOid: "head-213",
        title: "KT-123: adversarial regression suite",
        body: "",
        ciState: "passing",
        changedFiles: ["src/outputValidation.ts"],
        diff:
          "diff --git a/src/outputValidation.ts b/src/outputValidation.ts\n" +
          "--- a/src/outputValidation.ts\n" +
          "+++ b/src/outputValidation.ts\n" +
          "@@ -1,2 +1,3 @@\n" +
          " export type ExplanationOutputValidationReason =\n" +
          '+  | "UNSUPPORTED_SEMANTIC_CLAIM"\n' +
          '+  | "UNSUPPORTED_CURRENT_FACT_CLAIM";\n',
        diffTruncated: false,
      },
    });

    expect(reads).toEqual(["src/outputValidation.ts"]);
    expect(report.findings).toEqual([]);
    expect(report.reviewStatus).toBe("complete");
  });

  it("suppresses a test-literal absence claim when the expected literal exists in the exact target file", async () => {
    const root = await repository();
    const config = configFor(root);
    const gateway = new ScriptedGateway([
      response(
        JSON.stringify({
          summary: "One test mismatch.",
          findings: [
            {
              severity: "blocking",
              category: "tests",
              basis: "defect",
              title: "Test expects incorrect string in edge route test",
              path: "src/test/edge-route.test.ts",
              line: 12,
              side: "RIGHT",
              evidence:
                "The test at line 12 expects the edge function source to contain the exact string 'kt105Route.kind === \"question\"', but the actual code in supabase/functions/analysis/index.ts uses optional chaining. This mismatch will cause the test to fail.",
              recommendation: "Change the expected string in the test to match optional chaining.",
            },
          ],
        }),
      ),
    ]);
    const reads: string[] = [];

    const report = await runExternalPullRequestReview({
      root,
      config,
      gateway,
      readFile: async (path) => {
        reads.push(path);
        if (path === "src/test/edge-route.test.ts") {
          return {
            path,
            content:
              'import { readFileSync } from "node:fs";\n' +
              'const edge = readFileSync("supabase/functions/analysis/index.ts", "utf8");\n' +
              "\n".repeat(9) +
              "expect(edge).toContain('kt105Route.kind === \"question\"');\n",
          };
        }
        if (path === "supabase/functions/analysis/index.ts") {
          return {
            path,
            content:
              'const isQuestionRoute = kt105Route?.kind === "question";\n' +
              'if (kt105Route.kind === "question") {\n  handleQuestion();\n}\n',
          };
        }
        throw new Error("Unexpected read " + path);
      },
      lenses: ["bug_hunter"],
      material: {
        reference: "214",
        headRefOid: "head-214",
        title: "KT-124: Ask Krunditark",
        body: "",
        ciState: "passing",
        changedFiles: ["src/test/edge-route.test.ts", "supabase/functions/analysis/index.ts"],
        diff:
          "diff --git a/src/test/edge-route.test.ts b/src/test/edge-route.test.ts\n" +
          "--- /dev/null\n" +
          "+++ b/src/test/edge-route.test.ts\n" +
          "@@ -0,0 +1,12 @@\n" +
          '+import { readFileSync } from "node:fs";\n' +
          '+const edge = readFileSync("supabase/functions/analysis/index.ts", "utf8");\n' +
          "+\n+\n+\n+\n+\n+\n+\n+\n+\n" +
          "+expect(edge).toContain('kt105Route.kind === \"question\"');\n" +
          "diff --git a/supabase/functions/analysis/index.ts b/supabase/functions/analysis/index.ts\n" +
          "--- a/supabase/functions/analysis/index.ts\n" +
          "+++ b/supabase/functions/analysis/index.ts\n" +
          "@@ -1 +1,2 @@\n" +
          '+const isQuestionRoute = kt105Route?.kind === "question";\n' +
          '+if (kt105Route.kind === "question") handleQuestion();\n',
        diffTruncated: false,
      },
    });

    expect(reads).toEqual(["src/test/edge-route.test.ts", "supabase/functions/analysis/index.ts"]);
    expect(report.findings).toEqual([]);
    expect(report.reviewStatus).toBe("complete");
  });

  it("keeps the PR-214 truncated-history defect because exact changed-code evidence supports it", async () => {
    const root = await repository();
    const config = configFor(root);
    const gateway = new ScriptedGateway([
      response(
        JSON.stringify({
          summary: "History metadata defect.",
          findings: [
            {
              severity: "blocking",
              category: "correctness",
              basis: "defect",
              title: "truncated flag incorrectly initialized to true when older turns exist",
              path: "src/server/explanation/followUp.ts",
              line: 318,
              side: "RIGHT",
              evidence:
                "The changed line initializes truncated from older.length > 0, so the response reports truncation merely because the history exceeds the six-turn recent window, even when all older turn text fits without clipping or budget loss.",
              recommendation:
                "Initialize truncated to false and set it only when clipping or the byte budget actually drops content.",
            },
          ],
        }),
      ),
    ]);

    const report = await runExternalPullRequestReview({
      root,
      config,
      gateway,
      lenses: ["bug_hunter"],
      material: {
        reference: "214",
        headRefOid: "head-214",
        title: "KT-124: Ask Krunditark",
        body: "",
        ciState: "passing",
        changedFiles: ["src/server/explanation/followUp.ts"],
        diff:
          "diff --git a/src/server/explanation/followUp.ts b/src/server/explanation/followUp.ts\n" +
          "--- a/src/server/explanation/followUp.ts\n" +
          "+++ b/src/server/explanation/followUp.ts\n" +
          "@@ -317,2 +317,2 @@\n" +
          "   const parts: string[] = [];\n" +
          "-  let truncated = false;\n" +
          "+  let truncated = older.length > 0;\n",
        diffTruncated: false,
      },
    });

    expect(report.findings).toEqual([
      expect.objectContaining({
        title: "truncated flag incorrectly initialized to true when older turns exist",
        path: "src/server/explanation/followUp.ts",
        severity: "blocking",
      }),
    ]);
    expect(report.blockingCount).toBe(1);
  });

  it("rejects speculative TypeScript nullability findings without positive nullable evidence", async () => {
    const root = await repository();
    const config = configFor(root);
    const gateway = new ScriptedGateway([
      response(
        JSON.stringify({
          summary: "Speculative nullability claim.",
          findings: [
            {
              severity: "blocking",
              category: "correctness",
              basis: "defect",
              title: "Missing null/undefined handling",
              path: "src/value.ts",
              line: 1,
              side: "RIGHT",
              evidence:
                "The code uses value.items.filter without checking if value.items is null or undefined, which could cause a runtime error.",
              recommendation: "Use (value.items || []).filter(...).",
            },
          ],
        }),
      ),
    ]);

    const report = await runExternalPullRequestReview({
      root,
      config,
      gateway,
      lenses: ["bug_hunter"],
      material: {
        reference: "42",
        headRefOid: "head-42",
        title: "Typed array access",
        body: "",
        ciState: "passing",
        changedFiles: ["src/value.ts"],
        diff: "diff --git a/src/value.ts b/src/value.ts\n--- a/src/value.ts\n+++ b/src/value.ts\n@@ -1 +1 @@\n-export const count = 0;\n+export const count = value.items.filter(Boolean).length;\n",
        diffTruncated: false,
      },
    });

    expect(report.findings).toEqual([]);
  });

  it("keeps TypeScript nullability findings when the evidence positively shows an optional type", async () => {
    const root = await repository();
    const config = configFor(root);
    const gateway = new ScriptedGateway([
      response(
        JSON.stringify({
          summary: "Proven nullable access.",
          findings: [
            {
              severity: "blocking",
              category: "correctness",
              basis: "defect",
              title: "Optional items are dereferenced without a guard",
              path: "src/value.ts",
              line: 2,
              side: "RIGHT",
              evidence:
                "The supplied packet declares items?: string[] and the changed line calls value.items.filter directly, so undefined is allowed by the type.",
              recommendation: "Guard value.items or provide a default array before calling filter.",
            },
          ],
        }),
      ),
    ]);

    const report = await runExternalPullRequestReview({
      root,
      config,
      gateway,
      lenses: ["bug_hunter"],
      material: {
        reference: "42",
        headRefOid: "head-42",
        title: "Optional array access",
        body: "",
        ciState: "passing",
        changedFiles: ["src/value.ts"],
        diff: "diff --git a/src/value.ts b/src/value.ts\n--- a/src/value.ts\n+++ b/src/value.ts\n@@ -1 +1,2 @@\n-export const count = 0;\n+type Value = { items?: string[] };\n+export const count = (value: Value) => value.items.filter(Boolean).length;\n",
        diffTruncated: false,
      },
    });

    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]?.title).toBe("Optional items are dereferenced without a guard");
  });

  it("filters concrete findings that cannot map to an actual changed diff line", async () => {
    const root = await repository();
    const config = configFor(root);
    const gateway = new ScriptedGateway([
      response(
        JSON.stringify({
          summary: "Invalid inline target.",
          findings: [
            {
              severity: "blocking",
              category: "correctness",
              basis: "defect",
              title: "Finding points outside the patch",
              path: "src/value.ts",
              line: 99,
              side: "RIGHT",
              evidence: "The model cited a line that is not part of the changed hunk.",
              recommendation: "Do not publish unsupported inline findings.",
            },
          ],
        }),
      ),
    ]);

    const report = await runExternalPullRequestReview({
      root,
      config,
      gateway,
      lenses: ["bug_hunter"],
      material: {
        reference: "42",
        headRefOid: "head-42",
        title: "Invalid line target",
        body: "",
        ciState: "passing",
        changedFiles: ["src/value.ts"],
        diff: "diff --git a/src/value.ts b/src/value.ts\n--- a/src/value.ts\n+++ b/src/value.ts\n@@ -1 +1 @@\n-export const value = 1;\n+export const value = 2;\n",
        diffTruncated: false,
      },
    });

    expect(report.findings).toEqual([]);
  });

  it("recovers a transient external review lens failure before marking the review partial", async () => {
    const root = await repository();
    const config = configFor(root);
    const events: ReviewActivityEvent[] = [];
    let call = 0;
    const gateway: GatewayChatClient = {
      async createChatCompletion(request) {
        call += 1;
        if (call === 2) {
          throw new Error("simulated bug-hunter timeout");
        }
        return response(
          JSON.stringify({
            summary: request.messages[0]?.content?.includes("Security lens")
              ? "Security review completed."
              : "General review completed.",
            findings: [],
          }),
        );
      },
    };

    const report = await runExternalPullRequestReview({
      root,
      config,
      gateway,
      lenses: ["general", "bug_hunter", "security"],
      onActivity: (event) => events.push(event),
      material: {
        reference: "42",
        headRefOid: "head-42",
        title: "Partial lens review",
        body: "",
        ciState: "passing",
        changedFiles: ["src/value.ts"],
        diff: "diff --git a/src/value.ts b/src/value.ts\n--- a/src/value.ts\n+++ b/src/value.ts\n@@ -1 +1 @@\n-export const value = 1;\n+export const value = 2;\n",
        diffTruncated: false,
      },
    });

    expect(call).toBe(4);
    expect(report.reviewStatus).toBe("complete");
    expect(report.lensFailures).toEqual([]);
    expect(report.summary).toContain(
      "Focused review: 0 documented DoD/acceptance violation(s), 0 concrete defect/rule violation(s).",
    );
    expect(report.summary).not.toContain("Incomplete lenses:");
    expect(events).not.toContainEqual(
      expect.objectContaining({
        type: "lens-failed",
        lens: "bug_hunter",
      }),
    );
  });

  it("recovers a transient external review batch timeout without losing successful findings", async () => {
    const root = await repository();
    const config = configFor(root);
    let request = 0;
    const gateway: GatewayChatClient = {
      async createChatCompletion() {
        request += 1;
        if (request === 2) {
          throw new Error("simulated batch timeout");
        }
        return response(
          JSON.stringify({
            summary: "Focused batch complete.",
            findings:
              request === 1
                ? [
                    {
                      severity: "blocking",
                      category: "correctness",
                      basis: "defect",
                      title: "First batch defect",
                      path: "src/file-1.ts",
                      line: 1,
                      side: "RIGHT",
                      evidence: "The changed line returns the wrong value.",
                      recommendation: "Return the required value.",
                    },
                  ]
                : [],
          }),
        );
      },
    };

    const changedFiles = Array.from({ length: 7 }, (_, index) => "src/file-" + (index + 1) + ".ts");
    const diff = changedFiles
      .map(
        (path, index) =>
          "diff --git a/" +
          path +
          " b/" +
          path +
          "\n--- a/" +
          path +
          "\n+++ b/" +
          path +
          "\n@@ -1 +1 @@\n-export const value = " +
          index +
          ";\n+export const value = " +
          (index + 1) +
          ";\n",
      )
      .join("");

    const report = await runExternalPullRequestReview({
      root,
      config,
      gateway,
      lenses: ["general"],
      material: {
        reference: "42",
        headRefOid: "head-42",
        title: "Batch resilience",
        body: "",
        ciState: "passing",
        changedFiles,
        diff,
        diffTruncated: false,
      },
    });

    expect(request).toBe(3);
    expect(report.reviewStatus).toBe("complete");
    expect(report.findings).toEqual([
      expect.objectContaining({
        title: "First batch defect",
        path: "src/file-1.ts",
      }),
    ]);
    expect(report.lensFailures).toEqual([]);
  });

  it("preserves successful split-recovery findings when a sibling split still fails", async () => {
    const root = await repository();
    const config = configFor(root);
    let request = 0;
    const gateway: GatewayChatClient = {
      async createChatCompletion() {
        request += 1;

        if (request === 1 || request === 3) {
          throw new Error("simulated provider timeout");
        }

        return response(
          JSON.stringify({
            summary: "Recovered first split.",
            findings: [
              {
                severity: "blocking",
                category: "correctness",
                basis: "defect",
                title: "Recovered split defect",
                path: "src/file-1.ts",
                line: 1,
                side: "RIGHT",
                evidence: "The recovered split proves the changed line is incorrect.",
                recommendation: "Return the required value.",
              },
            ],
          }),
        );
      },
    };

    const changedFiles = ["src/file-1.ts", "src/file-2.ts"];
    const diff = changedFiles
      .map(
        (path, index) =>
          "diff --git a/" +
          path +
          " b/" +
          path +
          "\n--- a/" +
          path +
          "\n+++ b/" +
          path +
          "\n@@ -1 +1 @@\n-export const value = " +
          index +
          ";\n+export const value = " +
          (index + 1) +
          ";\n",
      )
      .join("");

    const report = await runExternalPullRequestReview({
      root,
      config,
      gateway,
      lenses: ["general"],
      material: {
        reference: "42",
        headRefOid: "head-42",
        title: "Partial split recovery",
        body: "",
        ciState: "passing",
        changedFiles,
        diff,
        diffTruncated: false,
      },
    });

    expect(request).toBe(3);
    expect(report.reviewStatus).toBe("partial");
    expect(report.findings).toEqual([
      expect.objectContaining({
        title: "Recovered split defect",
        path: "src/file-1.ts",
      }),
    ]);
    expect(report.lensFailures).toHaveLength(1);
    expect(report.lensFailures[0]?.reason).toContain("split recovery incomplete");
    expect(report.lensFailures[0]?.reason).toContain("src/file-2.ts");
    expect(report.lensFailures[0]?.reason).toContain("simulated provider timeout");
  });

  it("carries semantic failed-model avoidance into split recovery child batches", async () => {
    const root = await repository();
    const config = configFor(root);
    const gateway = new ScriptedGateway([
      response(null, undefined, "liquid/lfm-2.5-2.6b:free"),
      response(
        JSON.stringify({
          summary: "First split recovered.",
          findings: [],
        }),
        undefined,
        "nvidia/nemotron-3-super-120b-a12b:free",
      ),
      response(
        JSON.stringify({
          summary: "Second split recovered.",
          findings: [],
        }),
        undefined,
        "nvidia/nemotron-3.5-lightning:free",
      ),
    ]);
    const changedFiles = ["src/file-1.ts", "src/file-2.ts"];
    const diff = changedFiles
      .map(
        (path, index) =>
          "diff --git a/" +
          path +
          " b/" +
          path +
          "\n--- a/" +
          path +
          "\n+++ b/" +
          path +
          "\n@@ -1 +1 @@\n-export const value = " +
          index +
          ";\n+export const value = " +
          (index + 1) +
          ";\n",
      )
      .join("");

    const report = await runExternalPullRequestReview({
      root,
      config,
      gateway,
      lenses: ["bug_hunter"],
      maxSteps: 1,
      material: {
        reference: "213",
        headRefOid: "head-213",
        title: "Recovery routing",
        body: "",
        ciState: "passing",
        changedFiles,
        diff,
        diffTruncated: false,
      },
    });

    expect(gateway.requests).toHaveLength(3);
    expect(gateway.requests[1]?.routing?.avoidModels).toContain("liquid/lfm-2.5-2.6b:free");
    expect(gateway.requests[2]?.routing?.avoidModels).toContain("liquid/lfm-2.5-2.6b:free");
    expect(report.reviewStatus).toBe("complete");
    expect(report.lensFailures).toEqual([]);
  });

  it("carries semantic failed-model avoidance across sibling primary batches in one lens", async () => {
    const root = await repository();
    const config = configFor(root);
    const gateway = new ScriptedGateway([
      response(null, undefined, "liquid/lfm-2.5-2.6b:free"),
      response(
        JSON.stringify({ summary: "First batch repaired.", findings: [] }),
        undefined,
        "nvidia/nemotron-3.5-lightning:free",
      ),
      response(
        JSON.stringify({ summary: "Second batch clean.", findings: [] }),
        undefined,
        "dots-studio/dots-3-note-preview:free",
      ),
    ]);
    const changedFiles = Array.from({ length: 7 }, (_, index) => "src/file-" + index + ".ts");
    const diff = changedFiles
      .map(
        (path, index) =>
          "diff --git a/" +
          path +
          " b/" +
          path +
          "\n--- a/" +
          path +
          "\n+++ b/" +
          path +
          "\n@@ -1 +1 @@\n-export const value = " +
          index +
          ";\n+export const value = " +
          (index + 1) +
          ";\n",
      )
      .join("");

    const report = await runExternalPullRequestReview({
      root,
      config,
      gateway,
      lenses: ["general"],
      maxSteps: 3,
      material: {
        reference: "214",
        headRefOid: "head-214",
        title: "Sibling batch routing",
        body: "",
        ciState: "passing",
        changedFiles,
        diff,
        diffTruncated: false,
      },
    });

    expect(gateway.requests).toHaveLength(3);
    expect(gateway.requests[2]?.routing?.avoidModels).toContain("liquid/lfm-2.5-2.6b:free");
    expect(report.reviewStatus).toBe("complete");
  });

  it("surfaces an external review failure only after the recovery retry is exhausted", async () => {
    const root = await repository();
    const config = configFor(root);
    let requests = 0;
    const gateway: GatewayChatClient = {
      async createChatCompletion() {
        requests += 1;
        throw new Error("simulated provider timeout");
      },
    };

    await expect(
      runExternalPullRequestReview({
        root,
        config,
        gateway,
        lenses: ["general"],
        material: {
          reference: "42",
          headRefOid: "head-42",
          title: "Recovery exhaustion",
          body: "",
          ciState: "passing",
          changedFiles: ["src/value.ts"],
          diff: "diff --git a/src/value.ts b/src/value.ts\n--- a/src/value.ts\n+++ b/src/value.ts\n@@ -1 +1 @@\n-export const value = 1;\n+export const value = 2;\n",
          diffTruncated: false,
        },
      }),
    ).rejects.toThrow(/Recovery retry failed.*simulated provider timeout/);

    expect(requests).toBe(2);
  });

  it("reports empty structured output as a semantic model failure and repairs with another model", async () => {
    const root = await repository();
    const config = configFor(root);
    const gateway = new ScriptedGateway([
      response(null, undefined, "dots-studio/dots-3-note-preview:free"),
      response(
        JSON.stringify({
          summary: "Replacement model returned a valid report.",
          findings: [],
        }),
        undefined,
        "nvidia/nemotron-3.5-lightning:free",
      ),
    ]);

    const report = await runExternalPullRequestReview({
      root,
      config,
      gateway,
      lenses: ["general"],
      maxSteps: 3,
      material: {
        reference: "42",
        headRefOid: "head-42",
        title: "Semantic model failure",
        body: "",
        ciState: "passing",
        changedFiles: ["src/value.ts"],
        diff: "diff --git a/src/value.ts b/src/value.ts\n--- a/src/value.ts\n+++ b/src/value.ts\n@@ -1 +1 @@\n-export const value = 1;\n+export const value = 2;\n",
        diffTruncated: false,
      },
    });

    expect(report.reviewStatus).toBe("complete");
    expect(gateway.requests).toHaveLength(2);
    expect(gateway.requests[1]?.routing?.avoidModels).toContain(
      "dots-studio/dots-3-note-preview:free",
    );
    expect(gateway.modelFailures).toContainEqual({
      model: "dots-studio/dots-3-note-preview:free",
      responseModel: "dots-studio/dots-3-note-preview:free",
      task: "review_general",
      reason: "empty structured review content",
    });
    expect(gateway.modelSuccesses).toEqual([
      {
        model: "nvidia/nemotron-3.5-lightning:free",
        responseModel: "nvidia/nemotron-3.5-lightning:free",
        task: "review_general",
      },
    ]);
  });

  it("accepts a prose-prefixed structured review object", async () => {
    const root = await repository();
    const config = configFor(root);
    const gateway = new ScriptedGateway([
      response('Now I have enough context. {"summary":"Prefixed report parsed.","findings":[]}'),
    ]);

    const report = await runExternalPullRequestReview({
      root,
      config,
      gateway,
      lenses: ["general"],
      material: {
        reference: "42",
        headRefOid: "head-42",
        title: "Prefixed model response",
        body: "",
        ciState: "passing",
        changedFiles: ["src/value.ts"],
        diff: "diff --git a/src/value.ts b/src/value.ts\n--- a/src/value.ts\n+++ b/src/value.ts\n@@ -1 +1 @@\n-export const value = 1;\n+export const value = 2;\n",
        diffTruncated: false,
      },
    });

    expect(report.summary).toContain(
      "Focused review: 0 documented DoD/acceptance violation(s), 0 concrete defect/rule violation(s).",
    );
    expect(gateway.requests).toHaveLength(1);
  });

  it("captures the raw assistant response before structured filtering when debug capture is enabled", async () => {
    const root = await repository();
    const config = configFor(root);
    const events: ReviewActivityEvent[] = [];
    const raw = "Model preamble before parser validation.";
    const firstResponse = response(raw);
    Object.assign(firstResponse.choices[0]!.message, {
      reasoning_content: "provider-specific reasoning payload",
    });
    firstResponse.usage = {
      prompt_tokens: 1200,
      completion_tokens: 3000,
      total_tokens: 4200,
    };
    const gateway = new ScriptedGateway([
      firstResponse,
      response(JSON.stringify({ summary: "Recovered.", findings: [] })),
    ]);

    await runExternalPullRequestReview({
      root,
      config,
      gateway,
      lenses: ["general"],
      captureRawResponses: true,
      onActivity: (event) => events.push(event),
      material: {
        reference: "42",
        headRefOid: "head-42",
        title: "Raw response debug",
        body: "",
        ciState: "passing",
        changedFiles: ["src/value.ts"],
        diff: "diff --git a/src/value.ts b/src/value.ts\n--- a/src/value.ts\n+++ b/src/value.ts\n@@ -1 +1 @@\n-export const value = 1;\n+export const value = 2;\n",
        diffTruncated: false,
      },
    });

    const rawEvents = events.filter(
      (event): event is Extract<ReviewActivityEvent, { type: "model-raw-response" }> =>
        event.type === "model-raw-response",
    );
    expect(rawEvents).toHaveLength(2);
    expect(rawEvents[0]).toMatchObject({
      lens: "general",
      step: 1,
      content: raw,
      contentLength: raw.length,
      contentTruncated: false,
      rawResponseTruncated: false,
    });
    expect(rawEvents[0]?.rawResponseJson).toContain("provider-specific reasoning payload");
    expect(rawEvents[0]?.rawResponseJson).toContain('"completion_tokens":3000');
  });

  it("repairs a non-JSON review response instead of failing the lens immediately", async () => {
    const root = await repository();
    const config = configFor(root);
    const events: ReviewActivityEvent[] = [];
    const gateway = new ScriptedGateway([
      response("Now I have enough context and will provide the report."),
      response(JSON.stringify({ summary: "Repaired report.", findings: [] })),
    ]);

    const report = await runExternalPullRequestReview({
      root,
      config,
      gateway,
      lenses: ["general"],
      onActivity: (event) => events.push(event),
      material: {
        reference: "42",
        headRefOid: "head-42",
        title: "Repair response",
        body: "",
        ciState: "passing",
        changedFiles: ["src/value.ts"],
        diff: "diff --git a/src/value.ts b/src/value.ts\n--- a/src/value.ts\n+++ b/src/value.ts\n@@ -1 +1 @@\n-export const value = 1;\n+export const value = 2;\n",
        diffTruncated: false,
      },
    });

    expect(report.summary).toContain(
      "Focused review: 0 documented DoD/acceptance violation(s), 0 concrete defect/rule violation(s).",
    );
    expect(gateway.requests).toHaveLength(2);
    expect(gateway.requests[1]?.messages.at(-1)).toMatchObject({
      role: "user",
    });
    expect(gateway.requests[1]?.messages.at(-1)?.content).toContain(
      "Return ONLY one valid JSON object",
    );
    expect(gateway.requests[0]?.messages[0]?.content).toContain(
      'severity must be exactly "blocking" or "non_blocking"',
    );
    expect(gateway.requests[0]?.messages[0]?.content).toContain(
      'category must be exactly one of "correctness", "security", "reliability", "tests", "maintainability"',
    );
    expect(gateway.requests[1]?.messages.at(-1)?.content).toContain(
      'severity must be exactly "blocking" or "non_blocking"',
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "report-repair",
        lens: "general",
        attempt: 1,
        reason: "invalid_json",
      }),
    );
  });

  it("uses the external PR-head file reader instead of local working-tree bytes", async () => {
    const root = await repository();
    const config = configFor(root);
    const gateway = new ScriptedGateway([
      response(null, [
        {
          id: "read-pr-head-file",
          name: "read_file",
          arguments: { path: "src/value.ts", start_line: 1, end_line: 1 },
        },
      ]),
      response(
        JSON.stringify({
          summary: "Target head context verified.",
          findings: [],
        }),
      ),
    ]);

    await runExternalPullRequestReview({
      root,
      config,
      gateway,
      lenses: ["general"],
      readFile: (path, options) => ({
        path,
        startLine: options.startLine,
        endLine: options.endLine,
        content: "export const value = 99;",
      }),
      material: {
        reference: "42",
        headRefOid: "head-42",
        title: "Read target head",
        body: "",
        ciState: "passing",
        changedFiles: ["src/value.ts"],
        diff: "diff --git a/src/value.ts b/src/value.ts\n--- a/src/value.ts\n+++ b/src/value.ts\n@@ -1 +1 @@\n-export const value = 1;\n+export const value = 99;\n",
        diffTruncated: false,
      },
    });

    const toolMessage = gateway.requests[1]?.messages.at(-1)?.content ?? "";
    expect(toolMessage).toContain("export const value = 99;");
    expect(toolMessage).not.toContain("export const value = 2;");
  });

  it("marks bounded external review coverage partial when a changed file is outside the diff", async () => {
    const root = await repository();
    const config = configFor(root);
    const gateway = new ScriptedGateway([
      response(
        JSON.stringify({
          summary: "Reviewed the available patch.",
          findings: [],
        }),
      ),
    ]);

    const report = await runExternalPullRequestReview({
      root,
      config,
      gateway,
      lenses: ["general"],
      material: {
        reference: "42",
        headRefOid: "head-42",
        title: "Large pull request",
        body: "",
        ciState: "passing",
        changedFiles: ["src/value.ts", "src/omitted.ts"],
        diff: "diff --git a/src/value.ts b/src/value.ts\n--- a/src/value.ts\n+++ b/src/value.ts\n@@ -1 +1 @@\n-export const value = 1;\n+export const value = 2;\n",
        diffTruncated: true,
      },
    });

    expect(report.coverage).toBe("partial");
    expect(report.unreviewedFiles).toEqual(["src/omitted.ts"]);
    expect(report.summary).toContain("Review coverage: partial");
    expect(report.summary).toContain("was truncated or did not contain every changed file");
    expect(JSON.stringify(gateway.requests[0]?.messages[1])).toContain("src/value.ts");
    expect(JSON.stringify(gateway.requests[0]?.messages[1])).not.toContain("src/omitted.ts");
  });

  it("does not mutate an active workflow while reviewing an external pull request", async () => {
    const root = await repository();
    const config = configFor(root);
    const store = new WorkflowStateStore(root, config);
    await startWorkflow(store, "TASK-EXTERNAL-REVIEW");
    const before = await store.loadCurrent();

    const gateway = new ScriptedGateway([
      response(
        JSON.stringify({
          summary: "External PR is clear.",
          findings: [],
        }),
      ),
    ]);

    await runExternalPullRequestReview({
      root,
      config,
      gateway,
      lenses: ["general"],
      material: {
        reference: "42",
        headRefOid: "head-42",
        title: "Independent review",
        body: "",
        ciState: "passing",
        changedFiles: ["src/value.ts"],
        diff: "diff --git a/src/value.ts b/src/value.ts\n--- a/src/value.ts\n+++ b/src/value.ts\n@@ -1 +1 @@\n-export const value = 1;\n+export const value = 2;\n",
        diffTruncated: false,
      },
    });

    expect(await store.loadCurrent()).toEqual(before);
  });

  it("runs an ad-hoc review loop when no workflow is active", async () => {
    const root = await repository();
    const config = configFor(root);
    const store = new WorkflowStateStore(root, config);
    const gateway = new ScriptedGateway([
      response(
        JSON.stringify({
          summary: "No blocking defects found.",
          findings: [],
        }),
      ),
    ]);

    const result = await runReviewFixLoop({
      root,
      config,
      store,
      gateway,
      allowAdHoc: true,
    });

    expect(result.review.blockingCount).toBe(0);
    expect(result.reviewRounds).toBe(1);
    expect(result.fixRounds).toBe(0);
    expect(await store.loadCurrent()).toBeUndefined();
  });

  it("proposes but does not activate a repository rule after the same finding repeats three times", async () => {
    const root = await repository();
    const config = configFor(root);
    const store = new WorkflowStateStore(root, config);
    const finding = JSON.stringify({
      summary: "Repeated contract gap.",
      findings: [
        {
          severity: "blocking",
          category: "tests",
          basis: "defect",
          title: "Missing regression coverage",
          path: "src/value.ts",
          line: 1,
          evidence: "The changed behavior has no regression test.",
          recommendation: "Behavior changes must include a regression test.",
        },
      ],
    });
    const gateway = new ScriptedGateway([response(finding), response(finding), response(finding)]);

    await runCodeReview({ root, config, store, gateway });
    await runCodeReview({ root, config, store, gateway });
    await runCodeReview({ root, config, store, gateway });

    const constitution = await buildRepositoryConstitution(root, config);
    const proposal = constitution.rules.find(
      (rule) =>
        rule.kind === "proposed_rule" &&
        rule.text === "Behavior changes must include a regression test.",
    );

    expect(proposal).toBeDefined();
    expect(proposal?.status).toBe("proposed");
    expect(activeRepositoryRules(constitution).some((rule) => rule.id === proposal?.id)).toBe(
      false,
    );
  });

  it("moves CODE_REVIEW to FIXING for blocking findings", async () => {
    const root = await repository();
    const config = configFor(root);
    const store = new WorkflowStateStore(root, config);
    await startWorkflow(store, "TASK-700");
    await moveToCodeReview(store);

    const gateway = new ScriptedGateway([
      response(
        JSON.stringify({
          summary: "One blocking defect.",
          findings: [
            {
              severity: "blocking",
              category: "correctness",
              basis: "defect",
              title: "Incorrect value",
              path: "src/value.ts",
              line: 1,
              evidence: "The changed constant violates the expected contract.",
              recommendation: "Restore the required value.",
            },
          ],
        }),
      ),
    ]);

    const report = await runCodeReview({ root, config, store, gateway });
    expect(report.blockingCount).toBe(1);
    expect((await store.loadCurrent())?.state).toBe("FIXING");
    expect(gateway.requests[0]?.model).toBe("kilo-auto/free");
  });

  it("moves CODE_REVIEW to READY_TO_PUSH when review is clear", async () => {
    const root = await repository();
    const config = configFor(root);
    const store = new WorkflowStateStore(root, config);
    await startWorkflow(store, "TASK-701");
    await moveToCodeReview(store);

    const gateway = new ScriptedGateway([
      response(
        JSON.stringify({
          summary: "No blocking defects found.",
          findings: [],
        }),
      ),
    ]);

    const report = await runCodeReview({ root, config, store, gateway });
    expect(report.blockingCount).toBe(0);
    expect((await store.loadCurrent())?.state).toBe("READY_TO_PUSH");
  });

  it("blocks a clear model review when living-architecture evidence is missing", async () => {
    const root = await repository();
    await mkdir(join(root, "docs", "planning"), {
      recursive: true,
    });
    await writeFile(join(root, "docs", "planning", "APPROVED_PLAN.md"), "# Approved\n");
    await writeFile(join(root, "TASKS.md"), "# Tasks\n");

    const config = configFor(root);
    const store = new WorkflowStateStore(root, config);
    await startWorkflow(store, "TASK-702");
    await moveToCodeReview(store);

    const gateway = new ScriptedGateway([
      response(
        JSON.stringify({
          summary: "No code defects found.",
          findings: [],
        }),
      ),
    ]);

    const report = await runCodeReview({
      root,
      config,
      store,
      gateway,
    });

    expect(report.codeBlockingCount).toBe(0);
    expect(report.architectureImpact.unresolvedAreas).toContain("testing");
    expect(report.blockingCount).toBe(1);
    expect((await store.loadCurrent())?.state).toBe("FIXING");
  });

  it("allows review to advance when living-architecture evidence is synchronized", async () => {
    const root = await repository();
    await mkdir(join(root, "docs", "planning"), {
      recursive: true,
    });
    await writeFile(join(root, "docs", "planning", "APPROVED_PLAN.md"), "# Approved\n");
    await writeFile(join(root, "TASKS.md"), "# Tasks\n");
    await writeFile(join(root, "src", "value.test.ts"), "export const covered = true;\n");

    const config = configFor(root);
    const store = new WorkflowStateStore(root, config);
    await startWorkflow(store, "TASK-703");
    await moveToCodeReview(store);

    const gateway = new ScriptedGateway([
      response(
        JSON.stringify({
          summary: "No code defects found.",
          findings: [],
        }),
      ),
    ]);

    const report = await runCodeReview({
      root,
      config,
      store,
      gateway,
    });

    expect(report.architectureImpact.unresolvedCount).toBe(0);
    expect(report.blockingCount).toBe(0);
    expect((await store.loadCurrent())?.state).toBe("READY_TO_PUSH");
  });
});
