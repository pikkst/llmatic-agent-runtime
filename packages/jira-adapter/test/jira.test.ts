import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  WorkflowStateStore,
  createDefaultConfig,
  transitionWorkflow,
  type RepositoryDetection,
} from "@llmatic/core";
import {
  JiraTaskProvider,
  jiraConnectionFromEnvironment,
  selectJiraWorkflowTask,
  syncJiraWorkflowTask,
  validateJiraWorkflowTask,
  type JiraHttpRequest,
  type JiraHttpTransport,
} from "../src/jira.js";

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

const connection = {
  baseUrl: "https://example.atlassian.net",
  auth: {
    type: "basic" as const,
    email: "dev@example.test",
    apiToken: "secret-token",
  },
};

function issueJson(key = "KT-123") {
  return {
    id: "10001",
    key,
    fields: {
      summary: "Implement deterministic task provider",
      description: {
        type: "doc",
        version: 1,
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "Acceptance criteria" }],
          },
          {
            type: "paragraph",
            content: [{ type: "text", text: "Tests pass" }],
          },
        ],
      },
      status: {
        id: "3",
        name: "In Progress",
        statusCategory: { name: "In Progress" },
      },
      issuetype: { name: "Task" },
      priority: { name: "High" },
      assignee: { accountId: "acct-current", displayName: "Engineer" },
      labels: ["runtime"],
      updated: "2026-09-21T07:00:00.000+0000",
    },
  };
}

describe("jira adapter", () => {
  it("loads Basic auth configuration without persisting it in runtime config", () => {
    const result = jiraConnectionFromEnvironment({
      LLMATIC_JIRA_BASE_URL: "https://example.atlassian.net/",
      LLMATIC_JIRA_EMAIL: "dev@example.test",
      LLMATIC_JIRA_API_TOKEN: "token",
    });

    expect(result).toEqual({
      baseUrl: "https://example.atlassian.net",
      auth: {
        type: "basic",
        email: "dev@example.test",
        apiToken: "token",
      },
    });
  });

  it("reports safe live Jira identity and workspace target without exposing credentials", async () => {
    const transport: JiraHttpTransport = async (request) => {
      expect(request.url).toBe("https://api.atlassian.com/ex/jira/cloud-id/rest/api/3/myself");
      return {
        status: 200,
        statusText: "OK",
        body: JSON.stringify({
          accountId: "acct-current",
          displayName: "Engineer",
          emailAddress: "engineer@example.test",
        }),
      };
    };
    const provider = new JiraTaskProvider(
      configFor("/repo"),
      {
        baseUrl: "https://api.atlassian.com/ex/jira/cloud-id",
        siteUrl: "https://example.atlassian.net",
        auth: { type: "bearer", token: "sensitive-access-token" },
      },
      transport,
      {
        LLMATIC_JIRA_PROJECT_KEY: "kt",
        LLMATIC_JIRA_WORK_MODE: "project_queue",
      },
    );

    const info = await provider.getConnectionInfo();

    expect(info).toEqual({
      provider: "jira",
      connected: true,
      identity: {
        id: "acct-current",
        label: "Engineer",
        email: "engineer@example.test",
      },
      target: {
        label: "Jira project KT",
        url: "https://example.atlassian.net",
      },
      metadata: {
        projectKey: "KT",
        workMode: "project_queue",
        siteUrl: "https://example.atlassian.net",
      },
    });
    expect(JSON.stringify(info)).not.toContain("sensitive-access-token");
  });

  it("maps Jira v3 issue fields and ADF description into a task record", async () => {
    const requests: JiraHttpRequest[] = [];
    const transport: JiraHttpTransport = async (request) => {
      requests.push(request);
      return {
        status: 200,
        statusText: "OK",
        body: JSON.stringify(issueJson()),
      };
    };
    const provider = new JiraTaskProvider(configFor("/repo"), connection, transport);

    const task = await provider.getTask("KT-123");

    expect(task).toMatchObject({
      provider: "jira",
      id: "10001",
      key: "KT-123",
      summary: "Implement deterministic task provider",
      description: "Acceptance criteria\nTests pass",
      status: { name: "In Progress" },
      issueType: "Task",
      priority: "High",
      assignee: "Engineer",
      labels: ["runtime"],
      webUrl: "https://example.atlassian.net/browse/KT-123",
    });
    expect(requests[0]?.url).toContain("/rest/api/3/issue/KT-123?fields=");
    expect(requests[0]?.headers.Authorization).toMatch(/^Basic /);
  });

  it("lists assigned Jira recovery candidates in Jira rank order", async () => {
    const requests: JiraHttpRequest[] = [];
    const first = issueJson("KT-201");
    first.fields.status = {
      id: "1",
      name: "To Do",
      statusCategory: { name: "To Do" },
    };
    const second = issueJson("KT-202");
    second.fields.status = {
      id: "1",
      name: "To Do",
      statusCategory: { name: "To Do" },
    };

    const transport: JiraHttpTransport = async (request) => {
      requests.push(request);
      return {
        status: 200,
        statusText: "OK",
        body: JSON.stringify({ issues: [first, second] }),
      };
    };
    const provider = new JiraTaskProvider(configFor("/repo"), connection, transport, {
      LLMATIC_JIRA_PROJECT_KEY: "KT",
    });

    const tasks = await provider.listTasks();

    expect(tasks.map((task) => task.key)).toEqual(["KT-201", "KT-202"]);
    expect(requests[0]?.method).toBe("POST");
    expect(requests[0]?.url.endsWith("/rest/api/3/search/jql")).toBe(true);
    expect(JSON.parse(requests[0]?.body ?? "{}")).toMatchObject({
      maxResults: 50,
      jql: expect.stringContaining('project = "KT"'),
    });
  });

  it("enforces assigned_only even when custom recovery JQL is configured", async () => {
    const requests: JiraHttpRequest[] = [];
    const transport: JiraHttpTransport = async (request) => {
      requests.push(request);
      return {
        status: 200,
        statusText: "OK",
        body: JSON.stringify({ issues: [issueJson("KT-301")] }),
      };
    };
    const provider = new JiraTaskProvider(configFor("/repo"), connection, transport, {
      LLMATIC_JIRA_WORK_MODE: "assigned_only",
      LLMATIC_JIRA_RECOVERY_JQL: 'project = "KT" AND statusCategory != Done ORDER BY updated DESC',
    });

    await provider.listTasks();

    const body = JSON.parse(requests[0]?.body ?? "{}") as { jql?: string };
    expect(body.jql).toContain("assignee = currentUser()");
    expect(body.jql).toContain("ORDER BY updated DESC");
  });

  it("uses the full project queue only when project_queue is explicitly selected", async () => {
    const requests: JiraHttpRequest[] = [];
    const transport: JiraHttpTransport = async (request) => {
      requests.push(request);
      return {
        status: 200,
        statusText: "OK",
        body: JSON.stringify({ issues: [issueJson("KT-401")] }),
      };
    };
    const provider = new JiraTaskProvider(configFor("/repo"), connection, transport, {
      LLMATIC_JIRA_WORK_MODE: "project_queue",
      LLMATIC_JIRA_PROJECT_KEY: "KT",
    });

    await provider.listTasks();

    const body = JSON.parse(requests[0]?.body ?? "{}") as { jql?: string };
    expect(body.jql).toContain('project = "KT"');
    expect(body.jql).not.toContain("assignee = currentUser()");
  });

  it("requires an explicit scope for project_queue mode", async () => {
    const provider = new JiraTaskProvider(
      configFor("/repo"),
      connection,
      async () => ({ status: 200, statusText: "OK", body: "{}" }),
      { LLMATIC_JIRA_WORK_MODE: "project_queue" },
    );

    await expect(provider.listTasks()).rejects.toThrow("project_queue work mode requires");
  });

  it("blocks starting a task assigned to another user in assigned_only mode", async () => {
    const other = issueJson("KT-501");
    other.fields.assignee = {
      accountId: "acct-other",
      displayName: "Other Engineer",
    };

    const transport: JiraHttpTransport = async (request) => {
      if (request.url.endsWith("/rest/api/3/myself")) {
        return {
          status: 200,
          statusText: "OK",
          body: JSON.stringify({
            accountId: "acct-current",
            displayName: "Engineer",
          }),
        };
      }

      return {
        status: 200,
        statusText: "OK",
        body: JSON.stringify(other),
      };
    };
    const provider = new JiraTaskProvider(configFor("/repo"), connection, transport, {
      LLMATIC_JIRA_WORK_MODE: "assigned_only",
    });

    await expect(provider.assertSelectableTask("KT-501")).rejects.toThrow(
      "is not assigned to the current Jira user",
    );
  });

  it("selects the first Jira-ranked todo whose linked dependencies are done", async () => {
    const blocked = issueJson("KT-201") as ReturnType<typeof issueJson> & {
      fields: ReturnType<typeof issueJson>["fields"] & {
        issuelinks?: Array<Record<string, unknown>>;
      };
    };
    blocked.fields.status = {
      id: "1",
      name: "To Do",
      statusCategory: { name: "To Do" },
    };
    blocked.fields.issuelinks = [
      {
        type: { inward: "is blocked by", outward: "blocks" },
        inwardIssue: { key: "KT-200" },
      },
    ];

    const ready = issueJson("KT-202");
    ready.fields.status = {
      id: "1",
      name: "To Do",
      statusCategory: { name: "To Do" },
    };

    const dependency = issueJson("KT-200");
    dependency.fields.status = {
      id: "3",
      name: "In Progress",
      statusCategory: { name: "In Progress" },
    };

    const transport: JiraHttpTransport = async (request) => {
      if (request.url.endsWith("/rest/api/3/search/jql")) {
        return {
          status: 200,
          statusText: "OK",
          body: JSON.stringify({ issues: [blocked, ready] }),
        };
      }

      return {
        status: 200,
        statusText: "OK",
        body: JSON.stringify(dependency),
      };
    };
    const provider = new JiraTaskProvider(configFor("/repo"), connection, transport, {});

    const next = await provider.getNextTask();

    expect(next?.key).toBe("KT-202");
  });

  it("requires taskWrite approval before mutating Jira", async () => {
    const transport: JiraHttpTransport = async () => ({
      status: 200,
      statusText: "OK",
      body: "{}",
    });
    const provider = new JiraTaskProvider(configFor("/repo"), connection, transport);

    await expect(provider.addComment("KT-123", "Done")).rejects.toThrow("requires approval");
  });

  it("adds ADF comments and resolves transitions by name", async () => {
    const requests: JiraHttpRequest[] = [];
    const transport: JiraHttpTransport = async (request) => {
      requests.push(request);

      if (request.method === "GET" && request.url.endsWith("/transitions")) {
        return {
          status: 200,
          statusText: "OK",
          body: JSON.stringify({
            transitions: [{ id: "31", name: "Done", to: { name: "Done" } }],
          }),
        };
      }

      return { status: 204, statusText: "No Content", body: "" };
    };
    const config = configFor("/repo");
    config.permissions.taskWrite = "auto";
    const provider = new JiraTaskProvider(config, connection, transport);

    await provider.addComment("KT-123", "CI green\nMerged");
    const transition = await provider.transitionTask("KT-123", "done");

    expect(transition).toEqual({ id: "31", name: "Done", toStatus: "Done" });
    expect(JSON.parse(requests[0]?.body ?? "{}")).toMatchObject({
      body: {
        type: "doc",
        version: 1,
      },
    });
    expect(JSON.parse(requests.at(-1)?.body ?? "{}")).toEqual({
      transition: { id: "31" },
    });
  });

  it("selects and validates a Jira task through workflow states", async () => {
    const root = await mkdtemp(join(tmpdir(), "llmatic-jira-"));
    temporaryDirectories.push(root);

    const config = configFor(root);
    const store = new WorkflowStateStore(root, config);
    const transport: JiraHttpTransport = async (request) => {
      if (request.url.endsWith("/rest/api/3/myself")) {
        return {
          status: 200,
          statusText: "OK",
          body: JSON.stringify({
            accountId: "acct-current",
            displayName: "Engineer",
          }),
        };
      }

      return {
        status: 200,
        statusText: "OK",
        body: JSON.stringify(issueJson()),
      };
    };
    const provider = new JiraTaskProvider(config, connection, transport);

    const selected = await selectJiraWorkflowTask(store, provider, "KT-123");
    expect(selected.workflow.state).toBe("TASK_SELECTED");
    expect(selected.workflow.taskRef).toBe("KT-123");

    const validated = await validateJiraWorkflowTask(store, provider);
    expect(validated.workflow.state).toBe("TASK_VALIDATED");
    expect(
      validated.workflow.checkpoints.find(
        (checkpoint) =>
          checkpoint.kind === "ACTION" &&
          checkpoint.provider === "jira" &&
          checkpoint.action === "task.validate",
      ),
    ).toMatchObject({
      success: true,
      metadata: { taskKey: "KT-123" },
    });
  });

  it("syncs completion evidence and a Jira transition without changing workflow state", async () => {
    const root = await mkdtemp(join(tmpdir(), "llmatic-jira-"));
    temporaryDirectories.push(root);

    const config = configFor(root);
    config.permissions.taskWrite = "auto";
    const store = new WorkflowStateStore(root, config);
    const requests: JiraHttpRequest[] = [];
    const transport: JiraHttpTransport = async (request) => {
      requests.push(request);

      if (request.method === "GET") {
        return {
          status: 200,
          statusText: "OK",
          body: JSON.stringify({
            transitions: [{ id: "31", name: "Done", to: { name: "Done" } }],
          }),
        };
      }

      return { status: 204, statusText: "No Content", body: "" };
    };
    const provider = new JiraTaskProvider(config, connection, transport);

    await selectJiraWorkflowTask(
      store,
      new JiraTaskProvider(config, connection, async (request) => {
        if (request.url.endsWith("/rest/api/3/myself")) {
          return {
            status: 200,
            statusText: "OK",
            body: JSON.stringify({
              accountId: "acct-current",
              displayName: "Engineer",
            }),
          };
        }

        return {
          status: 200,
          statusText: "OK",
          body: JSON.stringify(issueJson()),
        };
      }),
      "KT-123",
    );
    await transitionWorkflow(store, "TASK_VALIDATED");

    const result = await syncJiraWorkflowTask(store, provider, {
      comment: "Merged as abc123",
      transition: "Done",
    });

    expect(result).toMatchObject({
      taskRef: "KT-123",
      commentAdded: true,
      transition: { id: "31", name: "Done" },
    });
    expect((await store.loadCurrent())?.state).toBe("TASK_VALIDATED");
    expect(requests.filter((request) => request.method === "POST")).toHaveLength(2);
  });
});
