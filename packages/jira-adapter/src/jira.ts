import type { AgentConfig, WorkflowRun, WorkflowStateStore } from "@llmatic/core";
import { recordActionCheckpoint, startWorkflow, transitionWorkflow } from "@llmatic/core";
import type {
  TaskProvider,
  TaskProviderOperationOptions,
  TaskRecord,
  TaskTransition,
} from "@llmatic/task-provider";
import { normalizeTaskLifecycleStatus } from "@llmatic/task-provider";

export type JiraWorkMode = "assigned_only" | "project_queue";

export interface JiraConnectionConfig {
  baseUrl: string;
  siteUrl?: string;
  auth: { type: "basic"; email: string; apiToken: string } | { type: "bearer"; token: string };
}

export interface JiraCurrentUser {
  accountId: string;
  displayName?: string;
  emailAddress?: string;
}

export interface JiraHttpRequest {
  method: "GET" | "POST";
  url: string;
  headers: Record<string, string>;
  body?: string;
}

export interface JiraHttpResponse {
  status: number;
  statusText: string;
  body: string;
}

export type JiraHttpTransport = (request: JiraHttpRequest) => Promise<JiraHttpResponse>;

export interface JiraWorkflowSyncOptions extends TaskProviderOperationOptions {
  comment?: string;
  transition?: string;
}

function permission(
  value: AgentConfig["permissions"]["taskRead"],
  name: string,
  approved: boolean,
): void {
  if (value === "deny") {
    throw new Error(name + " is denied by llmatic.agent.yaml.");
  }

  if (value === "ask" && !approved) {
    throw new Error(
      name + " requires approval. Re-run with --approve after reviewing the operation.",
    );
  }
}

function requireEnvironment(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error("Missing required environment variable " + name + ".");
  return value;
}

export function jiraWorkModeFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): JiraWorkMode {
  const value = environment.LLMATIC_JIRA_WORK_MODE?.trim().toLowerCase();

  if (!value || value === "assigned_only") return "assigned_only";
  if (value === "project_queue") return "project_queue";

  throw new Error(
    "LLMATIC_JIRA_WORK_MODE must be assigned_only or project_queue.",
  );
}

export function jiraConnectionFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): JiraConnectionConfig {
  const baseUrl = requireEnvironment(environment, "LLMATIC_JIRA_BASE_URL").replace(/\/+$/, "");
  const siteUrl = environment.LLMATIC_JIRA_SITE_URL?.trim()?.replace(/\/+$/, "");
  const bearerToken = environment.LLMATIC_JIRA_BEARER_TOKEN?.trim();

  if (bearerToken) {
    return {
      baseUrl,
      siteUrl,
      auth: { type: "bearer", token: bearerToken },
    };
  }

  return {
    baseUrl,
    siteUrl,
    auth: {
      type: "basic",
      email: requireEnvironment(environment, "LLMATIC_JIRA_EMAIL"),
      apiToken: requireEnvironment(environment, "LLMATIC_JIRA_API_TOKEN"),
    },
  };
}

function authorizationHeader(connection: JiraConnectionConfig): string {
  if (connection.auth.type === "bearer") {
    return "Bearer " + connection.auth.token;
  }

  return (
    "Basic " +
    Buffer.from(connection.auth.email + ":" + connection.auth.apiToken, "utf8").toString("base64")
  );
}

async function defaultTransport(request: JiraHttpRequest): Promise<JiraHttpResponse> {
  const response = await fetch(request.url, {
    method: request.method,
    headers: request.headers,
    body: request.body,
  });

  return {
    status: response.status,
    statusText: response.statusText,
    body: await response.text(),
  };
}

function splitJqlOrderBy(jql: string): { filter: string; orderBy?: string } {
  const match = /\border\s+by\b/i.exec(jql);
  if (!match || match.index === undefined) {
    return { filter: jql.trim() };
  }

  return {
    filter: jql.slice(0, match.index).trim(),
    orderBy: jql.slice(match.index).trim(),
  };
}

function assignedOnlyJql(jql: string): string {
  const { filter, orderBy } = splitJqlOrderBy(jql);
  const scoped = "(" + (filter || "statusCategory != Done") + ") AND assignee = currentUser()";
  return orderBy ? scoped + " " + orderBy : scoped;
}

function issueAssigneeAccountId(raw: Record<string, unknown>): string | undefined {
  const fields = (raw.fields ?? {}) as Record<string, unknown>;
  const assignee =
    fields.assignee && typeof fields.assignee === "object"
      ? (fields.assignee as Record<string, unknown>)
      : undefined;
  return typeof assignee?.accountId === "string" ? assignee.accountId : undefined;
}

function pathFor(reference: string): string {
  const value = reference.trim();
  if (!value) throw new Error("Jira issue reference must not be empty.");
  return encodeURIComponent(value);
}

function headers(connection: JiraConnectionConfig): Record<string, string> {
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    Authorization: authorizationHeader(connection),
  };
}

async function requestJson<T>(
  connection: JiraConnectionConfig,
  transport: JiraHttpTransport,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<T> {
  const response = await transport({
    method,
    url: connection.baseUrl + path,
    headers: headers(connection),
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (response.status < 200 || response.status >= 300) {
    const detail = response.body.trim();
    throw new Error(
      "Jira API request failed with " +
        response.status +
        " " +
        response.statusText +
        (detail ? ": " + detail.slice(0, 500) : ""),
    );
  }

  if (!response.body.trim()) return undefined as T;

  try {
    return JSON.parse(response.body) as T;
  } catch (error) {
    throw new Error(
      "Jira API returned invalid JSON: " + (error instanceof Error ? error.message : String(error)),
    );
  }
}

function adfText(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;

  const parts: string[] = [];

  function visit(node: unknown): void {
    if (!node || typeof node !== "object") return;
    const record = node as Record<string, unknown>;

    if (record.type === "text" && typeof record.text === "string") {
      parts.push(record.text);
    } else if (record.type === "hardBreak") {
      parts.push("\n");
    }

    if (Array.isArray(record.content)) {
      for (const child of record.content) visit(child);
      if (record.type === "paragraph" || record.type === "heading" || record.type === "listItem") {
        parts.push("\n");
      }
    }
  }

  visit(value);
  const text = parts
    .join("")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text || undefined;
}

function commentDocument(text: string) {
  const paragraphs = text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => ({
      type: "paragraph",
      content: line ? [{ type: "text", text: line }] : [],
    }));

  return {
    type: "doc",
    version: 1,
    content: paragraphs,
  };
}

function linkedDependencies(fields: Record<string, unknown>): string[] {
  const links = Array.isArray(fields.issuelinks) ? fields.issuelinks : [];
  const dependencies = new Set<string>();

  for (const value of links) {
    if (!value || typeof value !== "object") continue;
    const link = value as Record<string, unknown>;
    const type =
      link.type && typeof link.type === "object" ? (link.type as Record<string, unknown>) : {};
    const inwardDescription = String(type.inward ?? "").toLowerCase();
    const inwardIssue =
      link.inwardIssue && typeof link.inwardIssue === "object"
        ? (link.inwardIssue as Record<string, unknown>)
        : undefined;

    if (
      inwardIssue &&
      (inwardDescription.includes("blocked by") ||
        inwardDescription.includes("depends on") ||
        inwardDescription.includes("requires"))
    ) {
      const key = String(inwardIssue.key ?? "").trim();
      if (key) dependencies.add(key);
    }
  }

  return [...dependencies];
}

function taskFromIssue(connection: JiraConnectionConfig, raw: Record<string, unknown>): TaskRecord {
  const fields = (raw.fields ?? {}) as Record<string, unknown>;
  const status = (fields.status ?? {}) as Record<string, unknown>;
  const statusCategory = (status.statusCategory ?? {}) as Record<string, unknown>;
  const issueType = (fields.issuetype ?? {}) as Record<string, unknown>;
  const priority = (fields.priority ?? {}) as Record<string, unknown>;
  const assignee = (fields.assignee ?? {}) as Record<string, unknown>;
  const key = String(raw.key ?? "");
  const id = String(raw.id ?? "");
  const summary = String(fields.summary ?? "");
  const statusName = String(status.name ?? "");

  if (!id || !key || !summary || !statusName) {
    throw new Error("Jira issue response is missing id, key, summary, or status.");
  }

  const siteUrl =
    connection.siteUrl ??
    (connection.baseUrl.includes(".atlassian.net") ? connection.baseUrl : undefined);

  return {
    provider: "jira",
    id,
    key,
    summary,
    description: adfText(fields.description),
    status: {
      id: String(status.id ?? ""),
      name: statusName,
      category: typeof statusCategory.name === "string" ? statusCategory.name : undefined,
      lifecycle: normalizeTaskLifecycleStatus(
        statusName,
        typeof statusCategory.name === "string" ? statusCategory.name : undefined,
      ),
    },
    issueType: typeof issueType.name === "string" ? issueType.name : undefined,
    priority: typeof priority.name === "string" ? priority.name : undefined,
    assignee: typeof assignee.displayName === "string" ? assignee.displayName : undefined,
    labels: Array.isArray(fields.labels)
      ? fields.labels.filter((label): label is string => typeof label === "string")
      : [],
    updatedAt: typeof fields.updated === "string" ? fields.updated : undefined,
    webUrl: siteUrl ? siteUrl + "/browse/" + encodeURIComponent(key) : undefined,
    acceptanceCriteria: [],
    definitionOfDone: [],
    dependencies: linkedDependencies(fields),
    source: {
      type: "jira",
      location: siteUrl ? siteUrl + "/browse/" + encodeURIComponent(key) : undefined,
    },
  };
}

export class JiraTaskProvider implements TaskProvider {
  public readonly id = "jira";

  public constructor(
    private readonly runtimeConfig: AgentConfig,
    private readonly connection: JiraConnectionConfig,
    private readonly transport: JiraHttpTransport = defaultTransport,
    private readonly environment: NodeJS.ProcessEnv = process.env,
  ) {}

  public workMode(): JiraWorkMode {
    return jiraWorkModeFromEnvironment(this.environment);
  }

  public async getCurrentUser(
    options: TaskProviderOperationOptions = {},
  ): Promise<JiraCurrentUser> {
    permission(this.runtimeConfig.permissions.taskRead, "Task read", options.approved ?? false);

    const raw = await requestJson<Record<string, unknown>>(
      this.connection,
      this.transport,
      "GET",
      "/rest/api/3/myself",
    );
    const accountId = String(raw.accountId ?? "").trim();
    if (!accountId) {
      throw new Error("Jira current-user response is missing accountId.");
    }

    return {
      accountId,
      displayName:
        typeof raw.displayName === "string" ? raw.displayName : undefined,
      emailAddress:
        typeof raw.emailAddress === "string" ? raw.emailAddress : undefined,
    };
  }

  public async assertSelectableTask(
    reference: string,
    options: TaskProviderOperationOptions = {},
  ): Promise<void> {
    if (this.workMode() === "project_queue") return;

    permission(this.runtimeConfig.permissions.taskRead, "Task read", options.approved ?? false);
    const [currentUser, issue] = await Promise.all([
      this.getCurrentUser(options),
      requestJson<Record<string, unknown>>(
        this.connection,
        this.transport,
        "GET",
        "/rest/api/3/issue/" + pathFor(reference) + "?fields=assignee",
      ),
    ]);

    const assigneeAccountId = issueAssigneeAccountId(issue);
    if (!assigneeAccountId || assigneeAccountId !== currentUser.accountId) {
      throw new Error(
        "Jira task " +
          reference +
          " is not assigned to the current Jira user. Work mode assigned_only forbids starting it.",
      );
    }
  }

  public async getTask(
    reference: string,
    options: TaskProviderOperationOptions = {},
  ): Promise<TaskRecord> {
    permission(this.runtimeConfig.permissions.taskRead, "Task read", options.approved ?? false);

    const issue = await requestJson<Record<string, unknown>>(
      this.connection,
      this.transport,
      "GET",
      "/rest/api/3/issue/" +
        pathFor(reference) +
        "?fields=summary,description,status,issuetype,priority,assignee,labels,updated,issuelinks",
    );

    return taskFromIssue(this.connection, issue);
  }

  public async listTasks(options: TaskProviderOperationOptions = {}): Promise<TaskRecord[]> {
    permission(this.runtimeConfig.permissions.taskRead, "Task read", options.approved ?? false);

    const projectKey = this.environment.LLMATIC_JIRA_PROJECT_KEY?.trim();
    if (projectKey && !/^[A-Z][A-Z0-9_]*$/i.test(projectKey)) {
      throw new Error("LLMATIC_JIRA_PROJECT_KEY contains an invalid Jira project key.");
    }

    const configuredJql = this.environment.LLMATIC_JIRA_RECOVERY_JQL?.trim();
    const workMode = this.workMode();

    if (workMode === "project_queue" && !projectKey && !configuredJql) {
      throw new Error(
        "Jira project_queue work mode requires LLMATIC_JIRA_PROJECT_KEY or LLMATIC_JIRA_RECOVERY_JQL.",
      );
    }

    const scope = projectKey ? 'project = "' + projectKey.toUpperCase() + '" AND ' : "";
    const defaultJql =
      scope +
      (workMode === "assigned_only" ? "assignee = currentUser() AND " : "") +
      "statusCategory != Done ORDER BY Rank ASC, priority DESC, updated ASC";
    const jql =
      workMode === "assigned_only" && configuredJql
        ? assignedOnlyJql(configuredJql)
        : configuredJql || defaultJql;

    const result = await requestJson<{ issues?: Array<Record<string, unknown>> }>(
      this.connection,
      this.transport,
      "POST",
      "/rest/api/3/search/jql",
      {
        jql,
        maxResults: 50,
        fields: [
          "summary",
          "description",
          "status",
          "issuetype",
          "priority",
          "assignee",
          "labels",
          "updated",
          "issuelinks",
        ],
      },
    );

    return (result.issues ?? []).map((issue) => taskFromIssue(this.connection, issue));
  }

  public async getNextTask(
    options: TaskProviderOperationOptions = {},
  ): Promise<TaskRecord | undefined> {
    const tasks = await this.listTasks(options);
    const candidates = tasks.filter((task) => task.status.lifecycle === "todo");
    const dependencyCache = new Map<string, TaskRecord | undefined>();

    for (const candidate of candidates) {
      let blocked = false;

      for (const dependency of candidate.dependencies) {
        let task = dependencyCache.get(dependency);
        if (!dependencyCache.has(dependency)) {
          task = await this.getTask(dependency, options).catch(() => undefined);
          dependencyCache.set(dependency, task);
        }

        if (!task || task.status.lifecycle !== "done") {
          blocked = true;
          break;
        }
      }

      if (!blocked) return candidate;
    }

    return undefined;
  }

  public async listTransitions(
    reference: string,
    options: TaskProviderOperationOptions = {},
  ): Promise<TaskTransition[]> {
    permission(this.runtimeConfig.permissions.taskRead, "Task read", options.approved ?? false);

    const result = await requestJson<{
      transitions?: Array<Record<string, unknown>>;
    }>(
      this.connection,
      this.transport,
      "GET",
      "/rest/api/3/issue/" + pathFor(reference) + "/transitions",
    );

    return (result.transitions ?? []).map((transition) => {
      const target = (transition.to ?? {}) as Record<string, unknown>;
      return {
        id: String(transition.id ?? ""),
        name: String(transition.name ?? ""),
        toStatus: typeof target.name === "string" ? target.name : undefined,
      };
    });
  }

  public async addComment(
    reference: string,
    text: string,
    options: TaskProviderOperationOptions = {},
  ): Promise<void> {
    permission(this.runtimeConfig.permissions.taskWrite, "Task write", options.approved ?? false);

    if (!text.trim()) throw new Error("Jira comment must not be empty.");

    await requestJson<unknown>(
      this.connection,
      this.transport,
      "POST",
      "/rest/api/3/issue/" + pathFor(reference) + "/comment",
      { body: commentDocument(text.trim()) },
    );
  }

  public async transitionTask(
    reference: string,
    transitionInput: string,
    options: TaskProviderOperationOptions = {},
  ): Promise<TaskTransition> {
    permission(this.runtimeConfig.permissions.taskWrite, "Task write", options.approved ?? false);

    const available = await this.listTransitions(reference, {
      approved: options.approved,
    });
    const normalized = transitionInput.trim().toLowerCase();

    if (!normalized) throw new Error("Jira transition must not be empty.");

    const transition = available.find(
      (candidate) =>
        candidate.id.toLowerCase() === normalized || candidate.name.toLowerCase() === normalized,
    );

    if (!transition) {
      throw new Error(
        "Jira transition " +
          transitionInput +
          " is not currently available. Available: " +
          available.map((candidate) => candidate.name).join(", "),
      );
    }

    await requestJson<unknown>(
      this.connection,
      this.transport,
      "POST",
      "/rest/api/3/issue/" + pathFor(reference) + "/transitions",
      { transition: { id: transition.id } },
    );

    return transition;
  }
}

export function createJiraTaskProviderFromEnvironment(
  runtimeConfig: AgentConfig,
  environment: NodeJS.ProcessEnv = process.env,
): JiraTaskProvider {
  return new JiraTaskProvider(
    runtimeConfig,
    jiraConnectionFromEnvironment(environment),
    defaultTransport,
    environment,
  );
}

export async function verifyJiraConnectionFromEnvironment(
  runtimeConfig: AgentConfig,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<JiraCurrentUser> {
  return createJiraTaskProviderFromEnvironment(runtimeConfig, environment).getCurrentUser({
    approved: true,
  });
}

function taskMetadata(task: TaskRecord): Record<string, string> {
  const metadata: Record<string, string> = {
    provider: task.provider,
    taskId: task.id,
    taskKey: task.key,
    status: task.status.name,
  };

  if (task.updatedAt) metadata.updatedAt = task.updatedAt;
  if (task.webUrl) metadata.url = task.webUrl;
  return metadata;
}

export async function selectJiraWorkflowTask(
  store: WorkflowStateStore,
  provider: JiraTaskProvider,
  reference: string,
  options: TaskProviderOperationOptions = {},
): Promise<{ task: TaskRecord; workflow: WorkflowRun }> {
  const task = await provider.getTask(reference, options);
  let workflow = await startWorkflow(store, task.key);

  await recordActionCheckpoint(store, {
    provider: "jira",
    action: "task.select",
    success: true,
    detail: task.summary,
    metadata: taskMetadata(task),
  });

  workflow = (await store.loadCurrent()) ?? workflow;
  return { task, workflow };
}

export async function validateJiraWorkflowTask(
  store: WorkflowStateStore,
  provider: JiraTaskProvider,
  options: TaskProviderOperationOptions = {},
): Promise<{ task: TaskRecord; workflow: WorkflowRun }> {
  const current = await store.loadCurrent();

  if (!current || current.state !== "TASK_SELECTED") {
    throw new Error("Jira task validation requires workflow state TASK_SELECTED.");
  }

  try {
    const task = await provider.getTask(current.taskRef, options);

    await recordActionCheckpoint(store, {
      provider: "jira",
      action: "task.validate",
      success: true,
      detail: task.summary,
      metadata: taskMetadata(task),
    });

    const workflow = await transitionWorkflow(store, "TASK_VALIDATED");
    return { task, workflow };
  } catch (error) {
    await recordActionCheckpoint(store, {
      provider: "jira",
      action: "task.validate",
      success: false,
      detail: error instanceof Error ? error.message : String(error),
      metadata: { taskKey: current.taskRef },
    });
    throw error;
  }
}

export async function syncJiraWorkflowTask(
  store: WorkflowStateStore,
  provider: JiraTaskProvider,
  options: JiraWorkflowSyncOptions,
): Promise<{
  taskRef: string;
  commentAdded: boolean;
  transition?: TaskTransition;
}> {
  const current = await store.loadCurrent();

  if (!current) throw new Error("No workflow is active.");

  const comment = options.comment?.trim();
  const transitionInput = options.transition?.trim();

  if (!comment && !transitionInput) {
    throw new Error("Jira sync requires a comment and/or transition.");
  }

  try {
    if (comment) {
      await provider.addComment(current.taskRef, comment, options);
    }

    const transition = transitionInput
      ? await provider.transitionTask(current.taskRef, transitionInput, options)
      : undefined;

    await recordActionCheckpoint(store, {
      provider: "jira",
      action: "task.sync",
      success: true,
      detail: [
        comment ? "comment" : undefined,
        transition ? "transition " + transition.name : undefined,
      ]
        .filter(Boolean)
        .join(", "),
      metadata: {
        taskKey: current.taskRef,
        ...(transition ? { transitionId: transition.id } : {}),
      },
    });

    return {
      taskRef: current.taskRef,
      commentAdded: Boolean(comment),
      transition,
    };
  } catch (error) {
    await recordActionCheckpoint(store, {
      provider: "jira",
      action: "task.sync",
      success: false,
      detail: error instanceof Error ? error.message : String(error),
      metadata: { taskKey: current.taskRef },
    });
    throw error;
  }
}
