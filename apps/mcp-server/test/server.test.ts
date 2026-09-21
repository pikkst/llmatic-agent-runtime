import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import {
  createDefaultConfig,
  detectRepository,
  serializeConfig,
} from "@llmatic/core";
import { createLlmaticMcpServer } from "../src/server.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

async function fixtureRepository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "llmatic-mcp-"));
  temporaryDirectories.push(root);

  await mkdir(join(root, ".git"));
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      packageManager: "pnpm@10.17.1",
      scripts: {
        test: "vitest run",
      },
    }),
  );

  const detection = await detectRepository(root);
  const config = createDefaultConfig(detection);
  await writeFile(join(root, "llmatic.agent.yaml"), serializeConfig(config));

  return root;
}

async function connectedClient() {
  const server = createLlmaticMcpServer();
  const client = new Client({
    name: "llmatic-mcp-test",
    version: "0.1.0",
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  return { server, client };
}

function textContent(result: { content: Array<{ type: string; text?: string }> }): string {
  const block = result.content.find((item) => item.type === "text");
  if (!block?.text) throw new Error("Expected text MCP content.");
  return block.text;
}

describe("LLMatic MCP server", () => {
  it("registers the runtime tool surface", async () => {
    const { server, client } = await connectedClient();

    try {
      const listed = await client.listTools();
      const names = listed.tools.map((tool) => tool.name);

      expect(names).toEqual(
        expect.arrayContaining([
          "llmatic_detect",
          "llmatic_workflow_status",
          "llmatic_workflow_start",
          "llmatic_workflow_transition",
          "llmatic_repo_search",
          "llmatic_workflow_analyze",
          "llmatic_git_status",
          "llmatic_git_stage",
          "llmatic_git_commit",
          "llmatic_workflow_branch",
          "llmatic_run_capability",
          "llmatic_workflow_validate",
          "llmatic_workflow_push",
          "llmatic_workflow_open_pr",
          "llmatic_github_pr_status",
          "llmatic_workflow_remote_ci",
          "llmatic_workflow_merge",
          "llmatic_tools_list",
        ]),
      );
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("serves repository detection over an MCP call", async () => {
    const root = await fixtureRepository();
    const { server, client } = await connectedClient();

    try {
      const result = await client.callTool({
        name: "llmatic_detect",
        arguments: { root },
      });
      const detection = JSON.parse(textContent(result));

      expect(detection).toMatchObject({
        root,
        git: true,
        packageManager: "pnpm",
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("persists workflow state across separate MCP tool calls", async () => {
    const root = await fixtureRepository();
    const { server, client } = await connectedClient();

    try {
      const started = await client.callTool({
        name: "llmatic_workflow_start",
        arguments: { root, task: "TASK-500" },
      });
      expect(JSON.parse(textContent(started))).toMatchObject({
        taskRef: "TASK-500",
        state: "TASK_SELECTED",
      });

      const status = await client.callTool({
        name: "llmatic_workflow_status",
        arguments: { root },
      });
      expect(JSON.parse(textContent(status))).toMatchObject({
        taskRef: "TASK-500",
        state: "TASK_SELECTED",
      });
    } finally {
      await client.close();
      await server.close();
    }
  });
});
