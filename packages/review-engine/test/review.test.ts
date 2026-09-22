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
  public constructor(private readonly responses: GatewayChatResponse[]) {}
  public async createChatCompletion(request: GatewayChatRequest): Promise<GatewayChatResponse> {
    this.requests.push(request);
    const response = this.responses.shift();
    if (!response) throw new Error("No scripted review response remains.");
    return response;
  }
}

function response(
  content: string | null,
  toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>,
): GatewayChatResponse {
  return {
    id: "review",
    model: "kilo-auto/free",
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
      response(null, [
        {
          id: "read-pr-diff",
          name: "read_diff",
          arguments: { path: "src/value.ts" },
        },
      ]),
      response(
        JSON.stringify({
          summary: "One concrete external PR defect.",
          findings: [
            {
              severity: "blocking",
              category: "correctness",
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
        reviews: [],
        comments: [],
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
    expect(gateway.requests[1]?.messages.at(-1)).toMatchObject({
      role: "tool",
      tool_call_id: "read-pr-diff",
    });
    expect(gateway.requests[1]?.messages.at(-1)?.content).toContain("+export const value = 2;");
    const system = JSON.stringify(gateway.requests[0]?.messages[0]);
    expect(system).toContain("external pull request");
    expect(system).toContain("untrusted project data");
    expect(JSON.stringify(gateway.requests[0]?.messages[1])).not.toContain("SECRET=do-not-send");
    expect(JSON.stringify(gateway.requests[0]?.messages[1])).not.toContain(".env");
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "constitution-start",
        "constitution-complete",
        "coverage",
        "lens-start",
        "model-request",
        "model-response",
        "tool-start",
        "tool-complete",
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

  it("keeps successful lenses when one external review lens fails", async () => {
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
            summary:
              request.messages[0]?.content?.includes("Security lens")
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

    expect(report.reviewStatus).toBe("partial");
    expect(report.lensFailures).toEqual([
      {
        lens: "bug_hunter",
        reason: "simulated bug-hunter timeout",
      },
    ]);
    expect(report.summary).toContain("general: General review completed.");
    expect(report.summary).toContain("security: Security review completed.");
    expect(report.summary).toContain("Incomplete lenses: bug_hunter");
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "lens-failed",
        lens: "bug_hunter",
      }),
    );
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

    expect(report.summary).toContain("Prefixed report parsed.");
    expect(gateway.requests).toHaveLength(1);
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

    expect(report.summary).toContain("Repaired report.");
    expect(gateway.requests).toHaveLength(2);
    expect(gateway.requests[1]?.messages.at(-1)).toMatchObject({
      role: "user",
    });
    expect(gateway.requests[1]?.messages.at(-1)?.content).toContain(
      "Return ONLY one valid JSON object",
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
