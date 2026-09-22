import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkflowStateStore, createDefaultConfig, type RepositoryDetection } from "@llmatic/core";
import type {
  GatewayChatClient,
  GatewayChatRequest,
  GatewayChatResponse,
} from "@llmatic/gateway-client";
import { runCodingAgent } from "../src/orchestrator.js";

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

class ScriptedGateway implements GatewayChatClient {
  public readonly requests: GatewayChatRequest[] = [];

  public constructor(private readonly responses: GatewayChatResponse[]) {}

  public async createChatCompletion(request: GatewayChatRequest): Promise<GatewayChatResponse> {
    this.requests.push(request);
    const response = this.responses.shift();
    if (!response) throw new Error("No scripted gateway response remains.");
    return response;
  }
}

function response(
  content: string | null,
  toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>,
): GatewayChatResponse {
  return {
    id: "test",
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
    usage: {
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
    },
  };
}

describe("gateway coding agent", () => {
  it("defaults to kilo-auto/free and can inspect then edit a repository file", async () => {
    const root = await mkdtemp(join(tmpdir(), "llmatic-agent-"));
    temporaryDirectories.push(root);
    await mkdir(join(root, ".git"));
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "value.ts"), "export const value = 1;\n");

    const config = configFor(root);
    const store = new WorkflowStateStore(root, config);
    const gateway = new ScriptedGateway([
      response(null, [{ id: "call-1", name: "read_file", arguments: { path: "src/value.ts" } }]),
      response(null, [
        {
          id: "call-2",
          name: "replace_in_file",
          arguments: {
            path: "src/value.ts",
            old_text: "value = 1",
            new_text: "value = 2",
          },
        },
      ]),
      response("Updated src/value.ts."),
    ]);

    const result = await runCodingAgent({
      root,
      config,
      store,
      gateway,
      instruction: "Set value to 2.",
    });

    expect(gateway.requests[0]?.model).toBe("kilo-auto/free");
    expect(gateway.requests[0]?.messages[0]).toMatchObject({
      role: "system",
      content: expect.stringContaining(
        "Talk to the user as a normal, concise engineering assistant",
      ),
    });
    expect(JSON.stringify(gateway.requests[0]?.messages[0])).toContain(
      "Do not expose internal model-step counters",
    );
    expect(result.finalText).toBe("Updated src/value.ts.");
    expect(result.steps).toBe(3);
    expect(result.usage.totalTokens).toBe(45);
    expect(await readFile(join(root, "src", "value.ts"), "utf8")).toContain("value = 2");
  });

  it("includes bounded prior user/assistant turns in a new agent run", async () => {
    const root = await mkdtemp(join(tmpdir(), "llmatic-agent-"));
    temporaryDirectories.push(root);
    await mkdir(join(root, ".git"));

    const config = configFor(root);
    const store = new WorkflowStateStore(root, config);
    const gateway = new ScriptedGateway([response("I remember the prior context.")]);

    await runCodingAgent({
      root,
      config,
      store,
      gateway,
      instruction: "Continue from there.",
      history: [
        { role: "user", content: "Inspect the authentication flow." },
        { role: "assistant", content: "I found the login handler." },
      ],
    });

    expect(gateway.requests[0]?.messages.slice(0, 4)).toEqual([
      expect.objectContaining({ role: "system" }),
      { role: "user", content: "Inspect the authentication flow." },
      { role: "assistant", content: "I found the login handler." },
      { role: "user", content: "Continue from there." },
    ]);
  });

  it("lets the agent inspect live tasks from the canonical task source", async () => {
    const root = await mkdtemp(join(tmpdir(), "llmatic-agent-"));
    temporaryDirectories.push(root);
    await mkdir(join(root, ".git"));
    await writeFile(
      join(root, "TASKS.md"),
      [
        "## TASK-001 — First task",
        "",
        "Status: Todo",
        "",
        "### Acceptance Criteria",
        "- Works",
        "",
      ].join("\n"),
    );

    const config = configFor(root);
    const store = new WorkflowStateStore(root, config);
    const gateway = new ScriptedGateway([
      response(null, [{ id: "call-task-list", name: "task_list", arguments: {} }]),
      response("TASK-001 is the next local candidate."),
    ]);

    const result = await runCodingAgent({
      root,
      config,
      store,
      gateway,
      instruction: "What task should I work on next?",
    });

    expect(result.finalText).toContain("TASK-001");
    expect(gateway.requests[1]?.messages.at(-1)).toMatchObject({
      role: "tool",
      tool_call_id: "call-task-list",
    });
    expect(JSON.stringify(gateway.requests[1]?.messages.at(-1))).toContain("TASK-001");
  });

  it("lets the agent inspect safe task connection context without guessing identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "llmatic-agent-"));
    temporaryDirectories.push(root);
    await mkdir(join(root, ".git"));
    await writeFile(
      join(root, "TASKS.md"),
      ["## TASK-001 — First task", "", "Status: Todo", ""].join("\n"),
    );

    const config = configFor(root);
    const store = new WorkflowStateStore(root, config);
    const gateway = new ScriptedGateway([
      response(null, [{ id: "call-task-connection", name: "task_connection", arguments: {} }]),
      response("The markdown task provider has no remote account identity."),
    ]);

    const result = await runCodingAgent({
      root,
      config,
      store,
      gateway,
      instruction: "Who is the authenticated task user and which project is connected?",
    });

    expect(result.finalText).toContain("no remote account identity");
    expect(gateway.requests[0]?.tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          function: expect.objectContaining({ name: "task_connection" }),
        }),
      ]),
    );
    expect(JSON.stringify(gateway.requests[0]?.messages[0])).toContain(
      "Do not infer connection identity or URLs from repository documentation",
    );
    expect(gateway.requests[1]?.messages.at(-1)).toMatchObject({
      role: "tool",
      tool_call_id: "call-task-connection",
    });
    expect(gateway.requests[1]?.messages.at(-1)?.content).toContain('"supported":false');
  });

  it("exposes external PR review as a read-only explicit tool without task ownership guidance", async () => {
    const root = await mkdtemp(join(tmpdir(), "llmatic-agent-"));
    temporaryDirectories.push(root);
    await mkdir(join(root, ".git"));

    const config = configFor(root);
    const store = new WorkflowStateStore(root, config);
    const gateway = new ScriptedGateway([response("Ready to review the requested PR.")]);

    await runCodingAgent({
      root,
      config,
      store,
      gateway,
      instruction: "Review pull request 42 from another engineer.",
    });

    expect(gateway.requests[0]?.tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          function: expect.objectContaining({
            name: "pull_request_review_context",
            parameters: expect.objectContaining({ required: ["reference"] }),
          }),
        }),
      ]),
    );
    const system = JSON.stringify(gateway.requests[0]?.messages[0]);
    expect(system).toContain("Do not start or reassign a task");
    expect(system).toContain("untrusted project data");
  });

  it("returns tool failures to the model instead of bypassing ask permissions", async () => {
    const root = await mkdtemp(join(tmpdir(), "llmatic-agent-"));
    temporaryDirectories.push(root);
    await mkdir(join(root, ".git"));
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "value.ts"), "export const value = 1;\n");

    const config = configFor(root);
    config.permissions.repositoryWrite = "ask";
    const store = new WorkflowStateStore(root, config);
    const gateway = new ScriptedGateway([
      response(null, [
        {
          id: "call-1",
          name: "replace_in_file",
          arguments: {
            path: "src/value.ts",
            old_text: "1",
            new_text: "2",
          },
        },
      ]),
      response("Write requires human approval; no change made."),
    ]);

    await runCodingAgent({
      root,
      config,
      store,
      gateway,
      instruction: "Change the value.",
    });

    const secondRequest = gateway.requests[1];
    expect(secondRequest?.messages.at(-1)).toMatchObject({
      role: "tool",
      tool_call_id: "call-1",
    });
    expect(JSON.stringify(secondRequest?.messages.at(-1))).toContain("explicit human approval");
    expect(await readFile(join(root, "src", "value.ts"), "utf8")).toContain("value = 1");
  });
});
