import { spawnSync } from "node:child_process";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import * as vscode from "vscode";
import { runCodingAgent, type CodingAgentEvent } from "@llmatic/agent-orchestrator";
import {
  inspectBootstrap,
  remediateBootstrap,
  type BootstrapReport,
} from "@llmatic/bootstrap-manager";
import { loadAgentConfig, WorkflowStateStore } from "@llmatic/core";
import {
  answerDiscoveryQuestion,
  answeredDiscoveryQuestions,
  createDiscoverySession,
  discoverySessionPath,
  discoverySummary,
  isGreenfieldRepository,
  loadDiscoverySession,
  nextDiscoveryQuestion,
  reopenDiscoveryAt,
  type DiscoveryQuestion,
  type DiscoverySession,
} from "@llmatic/discovery-engine";
import {
  externalConnectionProvider,
  pollBrokerConnection,
  refreshBrokerCredential,
  startBrokerConnection,
  type BrokerCredential,
  type BrokerResource,
} from "@llmatic/external-connections";
import { KiloGatewayClient } from "@llmatic/gateway-client";
import { verifyJiraConnectionFromEnvironment, type JiraWorkMode } from "@llmatic/jira-adapter";
import {
  approveCurrentProjectPlan,
  initializeApprovedProject,
  invalidateProjectApproval,
  loadProjectChangeRequest,
  planApprovalStatus,
  requestProjectPlanChanges,
} from "@llmatic/project-initializer";
import { buildPullRequestDraft } from "@llmatic/pr-draft";
import {
  generateProjectPlan,
  loadCurrentProjectPlan,
  loadProjectPlanManifest,
  type ProjectPlanManifest,
} from "@llmatic/planning-engine";
import {
  compareSemver,
  parseReleaseManifest,
  type ReleaseManifest,
} from "@llmatic/release-metadata";
import {
  loadLatestReviewReport,
  runCodeReview,
  runReviewFixLoop,
  type CodeReviewReport,
  type ReviewLoopEvent,
} from "@llmatic/review-engine";
import {
  ensureGlobalKiloMcpServer,
  isGlobalKiloLlmaticServerHealthy,
  readGlobalKiloLlmaticServer,
} from "@llmatic/kilo-connector";
import {
  installRuntimeBundle,
  inspectInstalledRuntime,
  readRuntimeManifest,
  type RuntimeInstallResult,
} from "@llmatic/runtime-installer";
import {
  evaluateSetupHealth,
  type SetupHealth,
  type SetupHealthIssue,
} from "@llmatic/setup-health";
import { stageVerifiedVsix } from "@llmatic/update-installer";
import { ensureManagedWorkspace, type ManagedWorkspace } from "@llmatic/workspace-manager";
import {
  decideRepositoryRuleProposal,
  type ConstitutionEntry,
} from "@llmatic/repository-constitution";
import {
  recoverWorkspace,
  workspaceRecoveryContext,
  type WorkspaceRecovery,
} from "@llmatic/workspace-recovery";
import { AgentChatViewProvider } from "./agent-chat-view.js";
import {
  LlmaticStatusDecorationProvider,
  LlmaticStatusProvider,
  type WorkspaceJiraStatus,
} from "./status-view.js";

const KILO_EXTENSION_ID = "kilocode.kilo-code";
const KILO_GATEWAY_SECRET = "llmatic.kiloGatewayApiKey";
const KILO_ANONYMOUS_STATE = "llmatic.kiloGatewayAnonymousAccepted";
const JIRA_PROFILE_STATE_KEY = "llmatic.jiraProfile.v1";
const JIRA_SECRET_PREFIX = "llmatic.jira.workspace";
const AUTO_FREE_WARNING_ACCEPTED = "llmatic.autoFreeDataWarningAccepted";
const ONBOARDING_VERSION = 1;

interface WorkspaceJiraProfile {
  baseUrl: string;
  siteUrl?: string;
  cloudId?: string;
  projectKey: string;
  workMode: JiraWorkMode;
  authType: "basic" | "bearer" | "oauth_broker";
  email?: string;
  recoveryJql?: string;
  brokerUrl?: string;
}

interface JiraOAuthCredential extends BrokerCredential {}

interface GatewayAccess {
  apiKey?: string;
  anonymous: boolean;
}

interface ExtensionState {
  activeWorkspace?: ManagedWorkspace;
  runtime?: RuntimeInstallResult;
  bootstrap?: BootstrapReport;
  health?: SetupHealth;
  kiloConnected: boolean;
  kiloReloadRecommended: boolean;
  gatewayKeyConfigured: boolean;
  recovery?: WorkspaceRecovery;
  lastError?: string;
}

interface DoctorCheck {
  name: string;
  status: "PASS" | "WARN" | "FAIL";
  detail: string;
}

interface KiloConnectionResult {
  connected: boolean;
  changed: boolean;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function configuration() {
  return vscode.workspace.getConfiguration("llmatic");
}

function jiraSecretKey(workspaceId: string, authType: "basic" | "bearer" | "oauth_broker"): string {
  return JIRA_SECRET_PREFIX + "." + workspaceId + "." + authType;
}

function workspaceJiraProfile(context: vscode.ExtensionContext): WorkspaceJiraProfile | undefined {
  return context.workspaceState.get<WorkspaceJiraProfile>(JIRA_PROFILE_STATE_KEY);
}

function connectionBrokerUrl(): string | undefined {
  const value = configuration().get<string>("connectionBrokerUrl", "").trim();
  return value ? value.replace(/\/+$/, "") : undefined;
}

function anonymousKiloAccessAvailable(): boolean {
  const model =
    configuration().get<string>("agentModel", "kilo-auto/free").trim() || "kilo-auto/free";
  return (
    configuration().get<boolean>("allowAnonymousKiloFree", true) && isAnonymousFreeKiloModel(model)
  );
}

function parseJiraOAuthCredential(raw: string | undefined): JiraOAuthCredential | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as JiraOAuthCredential;
    return parsed.accessToken?.trim() ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function jiraOAuthCredentialNeedsRefresh(credential: JiraOAuthCredential): boolean {
  if (!credential.expiresAt) return false;
  const expiresAt = Date.parse(credential.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt - Date.now() < 5 * 60 * 1000;
}

async function jiraOAuthCredential(
  context: vscode.ExtensionContext,
  workspaceId: string,
  profile: WorkspaceJiraProfile,
): Promise<JiraOAuthCredential | undefined> {
  const key = jiraSecretKey(workspaceId, "oauth_broker");
  let credential = parseJiraOAuthCredential(await context.secrets.get(key));
  if (!credential) return undefined;

  if (jiraOAuthCredentialNeedsRefresh(credential) && credential.refreshToken && profile.brokerUrl) {
    const refreshed = await refreshBrokerCredential(
      profile.brokerUrl,
      "atlassian",
      credential.refreshToken,
    );
    credential = refreshed.credential;
    await context.secrets.store(key, JSON.stringify(credential));
  }

  return credential;
}

function sanitizedJiraEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env };
  for (const key of [
    "LLMATIC_JIRA_BASE_URL",
    "LLMATIC_JIRA_SITE_URL",
    "LLMATIC_JIRA_EMAIL",
    "LLMATIC_JIRA_API_TOKEN",
    "LLMATIC_JIRA_BEARER_TOKEN",
    "LLMATIC_JIRA_PROJECT_KEY",
    "LLMATIC_JIRA_RECOVERY_JQL",
    "LLMATIC_JIRA_WORK_MODE",
  ]) {
    delete environment[key];
  }
  return environment;
}

async function taskRecoveryEnvironment(
  context: vscode.ExtensionContext,
  state: ExtensionState,
): Promise<NodeJS.ProcessEnv> {
  const taskSource = configuration().get<string>("taskSource", "auto").trim() || "auto";
  const fallbackProjectKey = configuration().get<string>("jiraProjectKey", "").trim();
  const fallbackRecoveryJql = configuration().get<string>("jiraRecoveryJql", "").trim();
  const fallbackWorkMode =
    configuration().get<JiraWorkMode>("jiraWorkMode", "assigned_only") ?? "assigned_only";
  const profile = workspaceJiraProfile(context);

  if (!profile) {
    return {
      ...process.env,
      LLMATIC_TASK_PROVIDER: taskSource,
      LLMATIC_JIRA_WORK_MODE: fallbackWorkMode,
      ...(fallbackProjectKey ? { LLMATIC_JIRA_PROJECT_KEY: fallbackProjectKey } : {}),
      ...(fallbackRecoveryJql ? { LLMATIC_JIRA_RECOVERY_JQL: fallbackRecoveryJql } : {}),
    };
  }

  if (!state.activeWorkspace) {
    const folder = firstWorkspaceFolder();
    if (!folder) return sanitizedJiraEnvironment();
    state.activeWorkspace = await attachWorkspace(context, folder);
  }

  const environment = sanitizedJiraEnvironment();
  const secret =
    profile.authType === "oauth_broker"
      ? undefined
      : await context.secrets.get(jiraSecretKey(state.activeWorkspace.id, profile.authType));
  const oauthCredential =
    profile.authType === "oauth_broker"
      ? await jiraOAuthCredential(context, state.activeWorkspace.id, profile)
      : undefined;

  environment.LLMATIC_TASK_PROVIDER = "jira";
  environment.LLMATIC_JIRA_BASE_URL = profile.baseUrl;
  environment.LLMATIC_JIRA_SITE_URL = profile.siteUrl ?? profile.baseUrl;
  environment.LLMATIC_JIRA_PROJECT_KEY = profile.projectKey;
  environment.LLMATIC_JIRA_WORK_MODE = profile.workMode;
  if (profile.recoveryJql) {
    environment.LLMATIC_JIRA_RECOVERY_JQL = profile.recoveryJql;
  }

  if (profile.authType === "basic") {
    if (profile.email) environment.LLMATIC_JIRA_EMAIL = profile.email;
    if (secret) environment.LLMATIC_JIRA_API_TOKEN = secret;
  } else if (profile.authType === "oauth_broker") {
    if (oauthCredential?.accessToken) {
      environment.LLMATIC_JIRA_BEARER_TOKEN = oauthCredential.accessToken;
    }
  } else if (secret) {
    environment.LLMATIC_JIRA_BEARER_TOKEN = secret;
  }

  return environment;
}

async function workspaceJiraStatus(
  context: vscode.ExtensionContext,
  state: ExtensionState,
): Promise<WorkspaceJiraStatus> {
  const profile = workspaceJiraProfile(context);
  const required = configuration().get<string>("taskSource", "auto") === "jira";

  if (!profile) {
    const environment = await taskRecoveryEnvironment(context, state);
    const baseUrl = environment.LLMATIC_JIRA_BASE_URL?.trim();
    const projectKey = environment.LLMATIC_JIRA_PROJECT_KEY?.trim();
    const connected = Boolean(
      baseUrl &&
      (environment.LLMATIC_JIRA_BEARER_TOKEN ||
        (environment.LLMATIC_JIRA_EMAIL && environment.LLMATIC_JIRA_API_TOKEN)),
    );

    return {
      connected,
      required,
      label: connected ? projectKey || "Environment" : undefined,
      detail: connected && baseUrl ? new URL(baseUrl).host : undefined,
      workMode:
        environment.LLMATIC_JIRA_WORK_MODE === "project_queue" ? "project_queue" : "assigned_only",
    };
  }

  if (!state.activeWorkspace) {
    const folder = firstWorkspaceFolder();
    if (folder) state.activeWorkspace = await attachWorkspace(context, folder);
  }

  const secret = state.activeWorkspace
    ? profile.authType === "oauth_broker"
      ? await jiraOAuthCredential(context, state.activeWorkspace.id, profile)
      : await context.secrets.get(jiraSecretKey(state.activeWorkspace.id, profile.authType))
    : undefined;

  return {
    connected: Boolean(secret),
    required: true,
    label: profile.projectKey,
    detail: new URL(profile.siteUrl ?? profile.baseUrl).host,
    workMode: profile.workMode,
  };
}

async function refreshJiraStatus(
  context: vscode.ExtensionContext,
  state: ExtensionState,
  statusProvider: LlmaticStatusProvider,
): Promise<void> {
  statusProvider.setJiraStatus(await workspaceJiraStatus(context, state));
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function chooseJiraWorkMode(
  existing?: WorkspaceJiraProfile,
): Promise<JiraWorkMode | undefined> {
  const workModePick = await vscode.window.showQuickPick(
    [
      {
        label: "$(organization) Team project — assigned to me only",
        description: "Safe default",
        detail: "LLMatic may only start Jira tasks assigned to your current Jira account.",
        mode: "assigned_only" as const,
      },
      {
        label: "$(person) Solo project — whole project queue",
        description: "Explicit opt-in",
        detail: "LLMatic may choose the next unblocked task from the scoped Jira project queue.",
        mode: "project_queue" as const,
      },
    ],
    {
      title: "LLMatic: Jira Work Ownership",
      placeHolder:
        existing?.workMode === "project_queue"
          ? "Current: solo project queue"
          : "Current: assigned to me only",
      ignoreFocusOut: true,
    },
  );

  return workModePick?.mode;
}

async function jiraProjectFromOAuthResource(
  resource: BrokerResource,
  accessToken: string,
  existing?: WorkspaceJiraProfile,
): Promise<string | undefined> {
  const apiBase = "https://api.atlassian.com/ex/jira/" + encodeURIComponent(resource.id);
  const response = await fetch(apiBase + "/rest/api/3/project/search?maxResults=100&orderBy=name", {
    headers: {
      Accept: "application/json",
      Authorization: "Bearer " + accessToken,
    },
  });

  if (response.ok) {
    const raw = (await response.json()) as {
      values?: Array<{ key?: string; name?: string }>;
    };
    const projects = (raw.values ?? [])
      .filter(
        (project): project is { key: string; name?: string } =>
          typeof project.key === "string" && Boolean(project.key.trim()),
      )
      .map((project) => ({
        label: project.key,
        description: project.name,
        key: project.key.toUpperCase(),
      }));

    if (projects.length > 0) {
      const selected = await vscode.window.showQuickPick(projects, {
        title: "LLMatic: Jira Project",
        placeHolder: existing?.projectKey
          ? "Current project: " + existing.projectKey
          : "Choose the Jira project for this repository",
        ignoreFocusOut: true,
      });
      return selected?.key;
    }
  }

  const projectKey = await vscode.window.showInputBox({
    title: "LLMatic: Jira Project",
    prompt: "Project key used to scope this repository's Jira work.",
    value: existing?.projectKey ?? "",
    placeHolder: "SNAPY or KT",
    ignoreFocusOut: true,
    validateInput: (value) =>
      /^[A-Z][A-Z0-9_]*$/i.test(value.trim())
        ? undefined
        : "Enter a Jira project key such as SNAPY or KT.",
  });
  return projectKey?.trim().toUpperCase();
}

async function persistJiraWorkspaceConnection(
  context: vscode.ExtensionContext,
  state: ExtensionState,
  statusProvider: LlmaticStatusProvider,
  chatProvider: AgentChatViewProvider,
  output: vscode.OutputChannel,
  profile: WorkspaceJiraProfile,
  secret: string,
  verifySecret: string,
): Promise<void> {
  const folder = firstWorkspaceFolder();
  if (!folder || !state.activeWorkspace) {
    throw new Error("No attached workspace is available for Jira connection.");
  }

  const verifyEnvironment = sanitizedJiraEnvironment();
  verifyEnvironment.LLMATIC_TASK_PROVIDER = "jira";
  verifyEnvironment.LLMATIC_JIRA_BASE_URL = profile.baseUrl;
  verifyEnvironment.LLMATIC_JIRA_SITE_URL = profile.siteUrl ?? profile.baseUrl;
  verifyEnvironment.LLMATIC_JIRA_PROJECT_KEY = profile.projectKey;
  verifyEnvironment.LLMATIC_JIRA_WORK_MODE = profile.workMode;
  if (profile.recoveryJql) {
    verifyEnvironment.LLMATIC_JIRA_RECOVERY_JQL = profile.recoveryJql;
  }
  if (profile.authType === "basic") {
    verifyEnvironment.LLMATIC_JIRA_EMAIL = profile.email;
    verifyEnvironment.LLMATIC_JIRA_API_TOKEN = verifySecret;
  } else {
    verifyEnvironment.LLMATIC_JIRA_BEARER_TOKEN = verifySecret;
  }

  const config = await loadAgentConfig(folder.uri.fsPath, {
    LLMATIC_HOME: context.globalStorageUri.fsPath,
  });
  const currentUser = await verifyJiraConnectionFromEnvironment(config, verifyEnvironment);

  await context.workspaceState.update(JIRA_PROFILE_STATE_KEY, profile);
  for (const authType of ["basic", "bearer", "oauth_broker"] as const) {
    await context.secrets.delete(jiraSecretKey(state.activeWorkspace.id, authType));
  }
  await context.secrets.store(jiraSecretKey(state.activeWorkspace.id, profile.authType), secret);

  await refreshJiraStatus(context, state, statusProvider);
  await refreshWorkspaceRecovery(context, state, statusProvider, chatProvider, output, true);

  await vscode.window.showInformationMessage(
    "Jira connected for this workspace as " +
      (currentUser.displayName ?? currentUser.emailAddress ?? currentUser.accountId) +
      ". Project " +
      profile.projectKey +
      " · " +
      (profile.workMode === "assigned_only" ? "assigned to me only" : "whole project queue") +
      ".",
  );
}

async function connectJiraWithBrowser(
  context: vscode.ExtensionContext,
  state: ExtensionState,
  statusProvider: LlmaticStatusProvider,
  chatProvider: AgentChatViewProvider,
  output: vscode.OutputChannel,
): Promise<boolean> {
  const brokerUrl = connectionBrokerUrl();
  const provider = externalConnectionProvider("jira");

  if (!brokerUrl) {
    const action = await vscode.window.showWarningMessage(
      "One-click Atlassian connection needs the LLMatic OAuth broker URL. The broker keeps the Atlassian client secret out of the VSIX.",
      "Configure Broker URL",
      "Use Manual Connection",
      "Open Setup Guide",
    );

    if (action === "Configure Broker URL") {
      const value = await vscode.window.showInputBox({
        title: "LLMatic: Connection Broker URL",
        prompt: "Public HTTPS origin of the deployed LLMatic OAuth broker.",
        placeHolder: "https://oauth.example.com",
        ignoreFocusOut: true,
        validateInput: (input) => {
          try {
            return new URL(input.trim()).protocol === "https:"
              ? undefined
              : "Use an HTTPS broker URL.";
          } catch {
            return "Enter a valid HTTPS URL.";
          }
        },
      });
      if (value?.trim()) {
        await configuration().update(
          "connectionBrokerUrl",
          value.trim().replace(/\/+$/, ""),
          vscode.ConfigurationTarget.Global,
        );
        return connectJiraWithBrowser(context, state, statusProvider, chatProvider, output);
      }
    } else if (action === "Open Setup Guide" && provider.documentationUrl) {
      await vscode.env.openExternal(vscode.Uri.parse(provider.documentationUrl));
    }

    return action !== "Use Manual Connection";
  }

  const started = await startBrokerConnection(brokerUrl, {
    provider: provider.brokerProvider ?? "atlassian",
    returnLabel: firstWorkspaceFolder()?.name,
  });

  const opened = await vscode.env.openExternal(vscode.Uri.parse(started.authorizeUrl));
  if (!opened) {
    throw new Error("VS Code could not open the Atlassian authorization page.");
  }

  const connected = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "LLMatic: waiting for Atlassian authorization",
      cancellable: true,
    },
    async (progress, cancellation) => {
      const expiresAt = Date.parse(started.expiresAt);
      while (!cancellation.isCancellationRequested && Date.now() < expiresAt) {
        const status = await pollBrokerConnection(brokerUrl, started.sessionId, started.pollToken);

        if (status.status === "connected") return status;
        if (status.status === "error") throw new Error(status.message);

        progress.report({ message: "Complete the Atlassian consent in your browser…" });
        await delay(1500);
      }
      return undefined;
    },
  );

  if (!connected) {
    await vscode.window.showWarningMessage(
      "Atlassian connection was cancelled or expired. Start Connect Jira Workspace to retry.",
    );
    return true;
  }

  if (connected.resources.length === 0) {
    throw new Error("Atlassian authorized successfully but returned no accessible Jira sites.");
  }

  const resource =
    connected.resources.length === 1
      ? connected.resources[0]
      : await vscode.window
          .showQuickPick(
            connected.resources.map((candidate) => ({
              label: candidate.name,
              description: candidate.url,
              resource: candidate,
            })),
            {
              title: "LLMatic: Jira Site",
              placeHolder: "Choose the Atlassian site for this repository",
              ignoreFocusOut: true,
            },
          )
          .then((selection) => selection?.resource);

  if (!resource) return true;

  const existing = workspaceJiraProfile(context);
  const projectKey = await jiraProjectFromOAuthResource(
    resource,
    connected.credential.accessToken,
    existing,
  );
  if (!projectKey) return true;

  const workMode = await chooseJiraWorkMode(existing);
  if (!workMode) return true;

  const profile: WorkspaceJiraProfile = {
    baseUrl: "https://api.atlassian.com/ex/jira/" + encodeURIComponent(resource.id),
    siteUrl: resource.url.replace(/\/+$/, ""),
    cloudId: resource.id,
    projectKey,
    workMode,
    authType: "oauth_broker",
    recoveryJql: existing?.recoveryJql,
    brokerUrl,
  };

  await persistJiraWorkspaceConnection(
    context,
    state,
    statusProvider,
    chatProvider,
    output,
    profile,
    JSON.stringify(connected.credential),
    connected.credential.accessToken,
  );
  return true;
}

async function connectJiraManually(
  context: vscode.ExtensionContext,
  state: ExtensionState,
  statusProvider: LlmaticStatusProvider,
  chatProvider: AgentChatViewProvider,
  output: vscode.OutputChannel,
): Promise<void> {
  if (!state.activeWorkspace) {
    throw new Error("Attach a workspace before configuring Jira.");
  }

  const existing = workspaceJiraProfile(context);
  const baseUrl = await vscode.window.showInputBox({
    title: "LLMatic: Manual Jira Connection",
    prompt: "Jira site URL for this repository/workspace.",
    value: existing?.siteUrl ?? existing?.baseUrl ?? "",
    placeHolder: "https://your-team.atlassian.net",
    ignoreFocusOut: true,
    validateInput: (value) => {
      try {
        const url = new URL(value.trim());
        return url.protocol === "https:" || url.protocol === "http:"
          ? undefined
          : "Use an http(s) Jira URL.";
      } catch {
        return "Enter a valid Jira URL.";
      }
    },
  });
  if (baseUrl === undefined) return;

  const projectKey = await vscode.window.showInputBox({
    title: "LLMatic: Jira Project",
    prompt: "Project key used to scope this repository's Jira work.",
    value: existing?.projectKey ?? "",
    placeHolder: "SNAPY or KT",
    ignoreFocusOut: true,
    validateInput: (value) =>
      /^[A-Z][A-Z0-9_]*$/i.test(value.trim())
        ? undefined
        : "Enter a Jira project key such as SNAPY or KT.",
  });
  if (projectKey === undefined) return;

  const workMode = await chooseJiraWorkMode(existing);
  if (!workMode) return;

  const authPick = await vscode.window.showQuickPick(
    [
      {
        label: "$(account) Email + API token",
        description: "Legacy/manual Jira Cloud authentication",
        authType: "basic" as const,
      },
      {
        label: "$(key) Bearer token",
        description: "Manual bearer authentication",
        authType: "bearer" as const,
      },
    ],
    {
      title: "LLMatic: Manual Jira Authentication",
      ignoreFocusOut: true,
    },
  );
  if (!authPick) return;

  let email: string | undefined;
  if (authPick.authType === "basic") {
    const value = await vscode.window.showInputBox({
      title: "LLMatic: Jira Email",
      value: existing?.authType === "basic" ? (existing.email ?? "") : "",
      prompt: "Email for the Jira API token.",
      ignoreFocusOut: true,
      validateInput: (input) => (input.trim() ? undefined : "Jira email is required."),
    });
    if (value === undefined) return;
    email = value.trim();
  }

  const existingSecret =
    existing?.authType === authPick.authType
      ? await context.secrets.get(jiraSecretKey(state.activeWorkspace.id, authPick.authType))
      : undefined;
  const secretInput = await vscode.window.showInputBox({
    title: authPick.authType === "basic" ? "LLMatic: Jira API Token" : "LLMatic: Jira Bearer Token",
    prompt: existingSecret
      ? "Leave blank to keep the existing secure token."
      : "Stored in VS Code SecretStorage for this workspace only.",
    password: true,
    ignoreFocusOut: true,
  });
  if (secretInput === undefined) return;
  const secret = secretInput.trim() || existingSecret;
  if (!secret) {
    await vscode.window.showErrorMessage("A Jira credential is required.");
    return;
  }

  const profile: WorkspaceJiraProfile = {
    baseUrl: baseUrl.trim().replace(/\/+$/, ""),
    siteUrl: baseUrl.trim().replace(/\/+$/, ""),
    projectKey: projectKey.trim().toUpperCase(),
    workMode,
    authType: authPick.authType,
    email,
    recoveryJql: existing?.recoveryJql,
  };

  await persistJiraWorkspaceConnection(
    context,
    state,
    statusProvider,
    chatProvider,
    output,
    profile,
    secret,
    secret,
  );
}

async function connectJiraWorkspace(
  context: vscode.ExtensionContext,
  state: ExtensionState,
  statusProvider: LlmaticStatusProvider,
  chatProvider: AgentChatViewProvider,
  output: vscode.OutputChannel,
): Promise<void> {
  const folder = firstWorkspaceFolder();
  if (!folder) {
    await vscode.window.showWarningMessage("Open a repository workspace before connecting Jira.");
    return;
  }

  if (!state.activeWorkspace) {
    state.activeWorkspace = await attachWorkspace(context, folder);
  }

  const existing = workspaceJiraProfile(context);
  const choice = await vscode.window.showQuickPick(
    [
      {
        label: "$(globe) Continue with Atlassian",
        description: "Recommended · browser sign-in and consent",
        detail:
          "No Jira API token to copy. LLMatic uses the configured OAuth broker and stores the resulting workspace credential securely.",
        action: "browser" as const,
      },
      {
        label: "$(key) Manual credentials",
        description: "Fallback",
        detail: "Use an email + API token or bearer token.",
        action: "manual" as const,
      },
      ...(existing
        ? [
            {
              label: "$(trash) Disconnect current Jira workspace",
              description: existing.projectKey,
              action: "disconnect" as const,
            },
          ]
        : []),
    ],
    {
      title: "LLMatic: Connect Jira Workspace",
      placeHolder: "Choose how to connect Jira for this repository",
      ignoreFocusOut: true,
    },
  );

  if (!choice) return;
  if (choice.action === "disconnect") {
    await vscode.commands.executeCommand("llmatic.disconnectJiraWorkspace");
    return;
  }
  if (choice.action === "manual") {
    await connectJiraManually(context, state, statusProvider, chatProvider, output);
    return;
  }

  const handled = await connectJiraWithBrowser(
    context,
    state,
    statusProvider,
    chatProvider,
    output,
  );
  if (!handled) {
    await connectJiraManually(context, state, statusProvider, chatProvider, output);
  }
}

async function disconnectJiraWorkspace(
  context: vscode.ExtensionContext,
  state: ExtensionState,
  statusProvider: LlmaticStatusProvider,
  chatProvider: AgentChatViewProvider,
  output: vscode.OutputChannel,
): Promise<void> {
  const profile = workspaceJiraProfile(context);
  if (!profile) {
    await vscode.window.showInformationMessage("No workspace-specific Jira profile is connected.");
    return;
  }

  const confirmation = await vscode.window.showWarningMessage(
    "Disconnect Jira from this workspace? Stored workspace credentials will be removed.",
    { modal: true },
    "Disconnect",
  );
  if (confirmation !== "Disconnect") return;

  if (!state.activeWorkspace) {
    const folder = firstWorkspaceFolder();
    if (folder) state.activeWorkspace = await attachWorkspace(context, folder);
  }
  if (state.activeWorkspace) {
    await context.secrets.delete(jiraSecretKey(state.activeWorkspace.id, "basic"));
    await context.secrets.delete(jiraSecretKey(state.activeWorkspace.id, "bearer"));
    await context.secrets.delete(jiraSecretKey(state.activeWorkspace.id, "oauth_broker"));
  }
  await context.workspaceState.update(JIRA_PROFILE_STATE_KEY, undefined);

  await refreshJiraStatus(context, state, statusProvider);
  await refreshWorkspaceRecovery(context, state, statusProvider, chatProvider, output, true).catch(
    () => undefined,
  );

  await vscode.window.showInformationMessage("Workspace Jira connection removed.");
}

function firstWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
  return vscode.workspace.workspaceFolders?.[0];
}

function runtimeOverridePath(): string | undefined {
  const override = configuration().get<string>("runtimeMcpPath", "").trim();
  return override || undefined;
}

function bundledMcpServerPath(context: vscode.ExtensionContext): string {
  return context.asAbsolutePath("dist/runtime/mcp-server.mjs");
}

function bundledRuntimeManifestPath(context: vscode.ExtensionContext): string {
  return context.asAbsolutePath("dist/runtime/manifest.json");
}

async function ensureExtensionRuntime(
  context: vscode.ExtensionContext,
): Promise<RuntimeInstallResult> {
  const override = runtimeOverridePath();

  if (override) {
    const serverPath = resolve(override);
    if (!(await exists(serverPath))) {
      throw new Error("Configured llmatic.runtimeMcpPath does not exist: " + serverPath);
    }

    return {
      runtimeVersion: "override",
      sha256: "override",
      serverPath,
      manifestPath: "",
      installDirectory: resolve(serverPath, ".."),
      changed: false,
      healthy: true,
      source: "override",
    };
  }

  return installRuntimeBundle({
    bundlePath: bundledMcpServerPath(context),
    manifestPath: bundledRuntimeManifestPath(context),
    runtimeHome: context.globalStorageUri.fsPath,
  });
}

async function inspectExtensionRuntime(
  context: vscode.ExtensionContext,
): Promise<RuntimeInstallResult> {
  const override = runtimeOverridePath();
  if (override) return ensureExtensionRuntime(context);

  const manifest = await readRuntimeManifest(bundledRuntimeManifestPath(context));
  return inspectInstalledRuntime(context.globalStorageUri.fsPath, manifest);
}

async function attachWorkspace(
  context: vscode.ExtensionContext,
  folder: vscode.WorkspaceFolder,
): Promise<ManagedWorkspace> {
  const managed = await ensureManagedWorkspace(folder.uri.fsPath, context.globalStorageUri.fsPath);

  await context.workspaceState.update("llmatic.workspaceId", managed.id);
  await context.workspaceState.update("llmatic.workspaceRoot", managed.root);
  return managed;
}

async function connectKilo(context: vscode.ExtensionContext): Promise<KiloConnectionResult> {
  const kilo = vscode.extensions.getExtension(KILO_EXTENSION_ID);
  if (!kilo) return { connected: false, changed: false };

  const runtime = await ensureExtensionRuntime(context);
  const nodeCommand = configuration().get<string>("nodeCommand", "node").trim() || "node";

  const registration = await ensureGlobalKiloMcpServer({
    homeDirectory: homedir(),
    serverPath: runtime.serverPath,
    llmaticHome: context.globalStorageUri.fsPath,
    nodeCommand,
  });

  return { connected: true, changed: registration.changed };
}

function issueDetail(issue: SetupHealthIssue): string {
  return issue.detail ? issue.label + ": " + issue.detail : issue.label;
}

async function evaluateExtensionHealth(
  context: vscode.ExtensionContext,
  state: ExtensionState,
): Promise<SetupHealth> {
  const folder = firstWorkspaceFolder();
  const runtime = state.runtime ?? (await inspectExtensionRuntime(context));
  const kiloInstalled = Boolean(vscode.extensions.getExtension(KILO_EXTENSION_ID));
  const nodeCommand = configuration().get<string>("nodeCommand", "node").trim() || "node";
  const autoConnectKilo = configuration().get<boolean>("autoConnectKilo", true);

  let bootstrap = state.bootstrap;
  if (folder && state.activeWorkspace) {
    bootstrap = await inspectBootstrap(state.activeWorkspace.root, state.activeWorkspace.config);
    state.bootstrap = bootstrap;
  }

  const server = kiloInstalled ? await readGlobalKiloLlmaticServer(homedir()) : undefined;
  const kiloMcpHealthy =
    kiloInstalled &&
    isGlobalKiloLlmaticServerHealthy(server, {
      serverPath: runtime.serverPath,
      llmaticHome: context.globalStorageUri.fsPath,
      nodeCommand,
    });

  const health = evaluateSetupHealth({
    workspaceOpen: Boolean(folder),
    workspaceAttached: Boolean(state.activeWorkspace),
    managedConfigPresent: Boolean(
      state.activeWorkspace && (await exists(state.activeWorkspace.configPath)),
    ),
    runtimeHealthy: runtime.healthy,
    missingRequiredTools:
      bootstrap?.requirements
        .filter((item) => item.level === "required" && !item.installed)
        .map((item) => item.name) ?? [],
    kiloRequired: autoConnectKilo,
    kiloInstalled,
    kiloMcpHealthy,
  });

  state.health = health;
  return health;
}

function writeHealthReport(output: vscode.OutputChannel, health: SetupHealth): void {
  output.appendLine("Health: " + health.status);
  if (health.issues.length === 0) {
    output.appendLine("[PASS] Runtime is ready.");
    return;
  }

  for (const issue of health.issues) {
    output.appendLine(
      "[" + (issue.kind === "repair" ? "REPAIR" : "SETUP") + "] " + issueDetail(issue),
    );
  }
}

function updateStatusBar(statusBar: vscode.StatusBarItem, state: ExtensionState): void {
  const health = state.health;
  statusBar.command = health?.status === "READY" ? "llmatic.showStatus" : "llmatic.getReady";

  if (state.lastError) {
    statusBar.text = "$(error) LLMatic: NEEDS REPAIR";
    statusBar.tooltip = state.lastError;
    statusBar.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
  } else if (!health || health.status === "NEEDS_SETUP") {
    statusBar.text = "$(tools) LLMatic: NEEDS SETUP";
    statusBar.tooltip = health?.issues.map(issueDetail).join("\n") ?? "Run LLMatic: Get Ready.";
    statusBar.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
  } else if (health.status === "NEEDS_REPAIR") {
    statusBar.text = "$(wrench) LLMatic: NEEDS REPAIR";
    statusBar.tooltip = health.issues.map(issueDetail).join("\n");
    statusBar.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
  } else {
    statusBar.text = "$(check) LLMatic: READY";
    statusBar.tooltip = "Workspace, runtime, required tools, and configured Kilo MCP are ready.";
    statusBar.backgroundColor = undefined;
  }

  statusBar.show();
}

async function refresh(
  context: vscode.ExtensionContext,
  statusBar: vscode.StatusBarItem,
  state: ExtensionState,
): Promise<void> {
  state.lastError = undefined;

  try {
    const folder = firstWorkspaceFolder();
    const autoAttach = configuration().get<boolean>("autoAttachWorkspace", true);

    if (folder && autoAttach) {
      state.activeWorkspace = await attachWorkspace(context, folder);
    } else if (!folder) {
      state.activeWorkspace = undefined;
    }

    state.runtime = await ensureExtensionRuntime(context);
    state.gatewayKeyConfigured = Boolean(await context.secrets.get(KILO_GATEWAY_SECRET));

    const autoConnect = configuration().get<boolean>("autoConnectKilo", true);
    if (autoConnect) {
      const kilo = await connectKilo(context);
      state.kiloConnected = kilo.connected;
      state.kiloReloadRecommended = kilo.changed;
    } else {
      state.kiloConnected = false;
      state.kiloReloadRecommended = false;
    }

    await evaluateExtensionHealth(context, state);
  } catch (error) {
    state.lastError = error instanceof Error ? error.message : String(error);
  }

  updateStatusBar(statusBar, state);
}

async function refreshWorkspaceRecovery(
  context: vscode.ExtensionContext,
  state: ExtensionState,
  statusProvider: LlmaticStatusProvider,
  chatProvider: AgentChatViewProvider,
  output?: vscode.OutputChannel,
  rebuildIndex = false,
): Promise<WorkspaceRecovery | undefined> {
  const folder = firstWorkspaceFolder();
  if (!folder) {
    state.recovery = undefined;
    statusProvider.update(state.health, state.gatewayKeyConfigured, undefined);
    chatProvider.setRecovery(undefined);
    return undefined;
  }

  if (!state.activeWorkspace) {
    state.activeWorkspace = await attachWorkspace(context, folder);
  }

  const config = await loadAgentConfig(folder.uri.fsPath, {
    LLMATIC_HOME: context.globalStorageUri.fsPath,
  });
  const store = new WorkflowStateStore(folder.uri.fsPath, config);
  const recovery = await recoverWorkspace(folder.uri.fsPath, config, store, {
    rebuildIndex,
    environment: await taskRecoveryEnvironment(context, state),
  });

  state.recovery = recovery;
  statusProvider.update(state.health, state.gatewayKeyConfigured, recovery);
  chatProvider.setRecovery(recovery);
  chatProvider.setReview(
    await loadLatestReviewReport(folder.uri.fsPath, config).catch(() => undefined),
  );

  if (output) {
    output.appendLine("");
    output.appendLine(
      "[MAP] " +
        recovery.repository.fileCount +
        " files, " +
        recovery.repository.symbolCount +
        " symbols, " +
        recovery.repository.importCount +
        " imports",
    );
    output.appendLine(
      "[RECOVERY] Task source: " +
        recovery.taskSource.selected +
        "; branch: " +
        (recovery.git.branch ?? "detached HEAD"),
    );
    if (recovery.workflow) {
      output.appendLine(
        "[RECOVERY] Workflow: " + recovery.workflow.taskRef + " / " + recovery.workflow.state,
      );
    }
    if (recovery.task) {
      output.appendLine(
        "[RECOVERY] Task: " +
          recovery.task.key +
          " — " +
          recovery.task.summary +
          " [" +
          recovery.task.status.name +
          "]",
      );
    } else if (recovery.nextTask) {
      output.appendLine(
        "[RECOVERY] Next task: " + recovery.nextTask.key + " — " + recovery.nextTask.summary,
      );
    }
    if (recovery.pullRequest) {
      output.appendLine(
        "[RECOVERY] PR #" +
          recovery.pullRequest.pullRequest.number +
          " / CI " +
          recovery.pullRequest.ciState,
      );
    }
    output.appendLine(
      "[NEXT] " + recovery.recommendation.title + " — " + recovery.recommendation.detail,
    );
  }

  return recovery;
}

function nodeVersion(nodeCommand: string): string | undefined {
  const result = spawnSync(nodeCommand, ["--version"], {
    encoding: "utf8",
    shell: false,
  });

  if (result.status !== 0) return undefined;
  return (result.stdout || result.stderr).trim().split(/\r?\n/)[0];
}

async function runDoctor(
  context: vscode.ExtensionContext,
  state: ExtensionState,
): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const folder = firstWorkspaceFolder();
  const runtime = await inspectExtensionRuntime(context);
  const serverPath = runtime.serverPath;
  const nodeCommand = configuration().get<string>("nodeCommand", "node").trim() || "node";
  const version = nodeVersion(nodeCommand);

  checks.push({
    name: "Workspace",
    status: folder && state.activeWorkspace ? "PASS" : "FAIL",
    detail:
      folder && state.activeWorkspace
        ? state.activeWorkspace.root
        : "No attached workspace is available.",
  });

  checks.push({
    name: "Managed config",
    status:
      state.activeWorkspace && (await exists(state.activeWorkspace.configPath)) ? "PASS" : "FAIL",
    detail: state.activeWorkspace?.configPath ?? "Managed workspace config is unavailable.",
  });

  checks.push({
    name: "Runtime integrity",
    status: runtime.healthy ? "PASS" : "FAIL",
    detail:
      runtime.source === "override"
        ? "Custom runtime override: " + runtime.serverPath
        : runtime.runtimeVersion + " / " + runtime.sha256.slice(0, 12) + " / " + runtime.serverPath,
  });

  let nodeStatus: DoctorCheck["status"] = "FAIL";
  if (version) {
    const major = Number(version.replace(/^v/, "").split(".")[0]);
    nodeStatus = Number.isFinite(major) && major >= 20 ? "PASS" : "FAIL";
  }
  checks.push({
    name: "Node.js",
    status: nodeStatus,
    detail: version ? nodeCommand + " " + version : nodeCommand + " is not available on PATH.",
  });

  const kiloInstalled = Boolean(vscode.extensions.getExtension(KILO_EXTENSION_ID));
  checks.push({
    name: "Kilo Code",
    status: kiloInstalled ? "PASS" : "WARN",
    detail: kiloInstalled ? KILO_EXTENSION_ID : "Kilo Code is not installed.",
  });

  const server = kiloInstalled ? await readGlobalKiloLlmaticServer(homedir()) : undefined;
  const kiloHealthy =
    kiloInstalled &&
    isGlobalKiloLlmaticServerHealthy(server, {
      serverPath,
      llmaticHome: context.globalStorageUri.fsPath,
      nodeCommand,
    });

  checks.push({
    name: "Kilo MCP",
    status: kiloHealthy ? "PASS" : kiloInstalled ? "FAIL" : "WARN",
    detail: kiloHealthy
      ? "Global LLMatic MCP registration matches this extension."
      : "Global LLMatic MCP registration is missing or stale.",
  });

  const hasGatewayKey = Boolean(await context.secrets.get(KILO_GATEWAY_SECRET));
  checks.push({
    name: "Kilo Gateway key",
    status: hasGatewayKey ? "PASS" : "WARN",
    detail: hasGatewayKey
      ? "Stored in VS Code SecretStorage; direct agent and review are enabled."
      : "Not configured; Kilo MCP still works, but direct LLMatic agent and review require this key.",
  });

  return checks;
}

async function repairRuntime(
  context: vscode.ExtensionContext,
  state: ExtensionState,
  statusBar: vscode.StatusBarItem,
  output: vscode.OutputChannel,
): Promise<void> {
  const override = runtimeOverridePath();
  if (override) {
    throw new Error(
      "Runtime repair is disabled while llmatic.runtimeMcpPath override is configured.",
    );
  }

  const runtime = await installRuntimeBundle({
    bundlePath: bundledMcpServerPath(context),
    manifestPath: bundledRuntimeManifestPath(context),
    runtimeHome: context.globalStorageUri.fsPath,
    force: true,
  });

  state.runtime = runtime;

  const kiloInstalled = Boolean(vscode.extensions.getExtension(KILO_EXTENSION_ID));
  let kiloChanged = false;

  if (kiloInstalled) {
    const kilo = await connectKilo(context);
    state.kiloConnected = kilo.connected;
    state.kiloReloadRecommended = kilo.changed;
    kiloChanged = kilo.changed;
  }

  state.lastError = undefined;
  updateStatusBar(statusBar, state);

  output.clear();
  output.appendLine("LLMatic Runtime Repair");
  output.appendLine("");
  output.appendLine("[PASS] Runtime: " + runtime.runtimeVersion);
  output.appendLine("[PASS] SHA-256: " + runtime.sha256);
  output.appendLine("[PASS] Installed: " + runtime.serverPath);
  output.appendLine(
    kiloInstalled
      ? "[PASS] Kilo MCP: " + (kiloChanged ? "registration repaired" : "already healthy")
      : "[WARN] Kilo Code: not installed",
  );
  output.show(true);

  const action = kiloChanged
    ? await vscode.window.showInformationMessage(
        "LLMatic runtime repaired and Kilo MCP updated.",
        "Reload Window",
      )
    : await vscode.window.showInformationMessage("LLMatic runtime is healthy.");

  if (action === "Reload Window") {
    await vscode.commands.executeCommand("workbench.action.reloadWindow");
  }
}

interface GithubReleaseAsset {
  name: string;
  browser_download_url: string;
}

interface GithubReleaseResponse {
  html_url: string;
  tag_name: string;
  assets: GithubReleaseAsset[];
}

interface LatestRelease {
  manifest: ReleaseManifest;
  releaseUrl: string;
  vsixUrl: string;
}

async function fetchLatestReleaseManifest(): Promise<LatestRelease> {
  const repository =
    configuration().get<string>("releaseRepository", "pikkst/llmatic-agent-runtime").trim() ||
    "pikkst/llmatic-agent-runtime";
  const releaseResponse = await fetch(
    "https://api.github.com/repos/" + repository + "/releases/latest",
    {
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );

  if (!releaseResponse.ok) {
    throw new Error(
      "GitHub latest-release request failed with " +
        releaseResponse.status +
        " " +
        releaseResponse.statusText,
    );
  }

  const release = (await releaseResponse.json()) as GithubReleaseResponse;
  const manifestAsset = release.assets.find((asset) => asset.name === "release-manifest.json");
  if (!manifestAsset) {
    throw new Error("Latest LLMatic release does not contain release-manifest.json.");
  }

  const manifestResponse = await fetch(manifestAsset.browser_download_url, {
    headers: { Accept: "application/json" },
  });

  if (!manifestResponse.ok) {
    throw new Error(
      "Release manifest download failed with " +
        manifestResponse.status +
        " " +
        manifestResponse.statusText,
    );
  }

  const manifest = parseReleaseManifest(await manifestResponse.json());
  if (manifest.repository !== repository) {
    throw new Error(
      "Release manifest repository " +
        manifest.repository +
        " does not match configured repository " +
        repository +
        ".",
    );
  }
  if (manifest.tag !== release.tag_name) {
    throw new Error(
      "Release tag " + release.tag_name + " does not match manifest tag " + manifest.tag + ".",
    );
  }

  const vsixAsset = release.assets.find((asset) => asset.name === manifest.vsix.file);
  if (!vsixAsset) {
    throw new Error("Latest release does not contain the VSIX declared by its manifest.");
  }

  return {
    manifest,
    releaseUrl: release.html_url,
    vsixUrl: vsixAsset.browser_download_url,
  };
}

async function installLatestUpdate(
  context: vscode.ExtensionContext,
  latest?: LatestRelease,
): Promise<void> {
  const currentVersion = String(context.extension.packageJSON.version ?? "0.0.0");
  const release = latest ?? (await fetchLatestReleaseManifest());

  if (compareSemver(release.manifest.version, currentVersion) <= 0) {
    await vscode.window.showInformationMessage("LLMatic " + currentVersion + " is up to date.");
    return;
  }

  const confirm = await vscode.window.showWarningMessage(
    "Install verified LLMatic " +
      release.manifest.version +
      " over installed " +
      currentVersion +
      "? The VSIX SHA-256 will be verified before VS Code installs it.",
    { modal: true },
    "Download & Install",
  );
  if (confirm !== "Download & Install") return;

  const response = await fetch(release.vsixUrl, {
    headers: { Accept: "application/octet-stream" },
  });
  if (!response.ok) {
    throw new Error("VSIX download failed with " + response.status + " " + response.statusText);
  }

  const staged = await stageVerifiedVsix({
    bytes: new Uint8Array(await response.arrayBuffer()),
    expected: release.manifest.vsix,
    updateHome: context.globalStorageUri.fsPath,
    version: release.manifest.version,
  });

  await vscode.commands.executeCommand(
    "workbench.extensions.installExtension",
    vscode.Uri.file(staged.path),
  );

  const action = await vscode.window.showInformationMessage(
    "LLMatic " + release.manifest.version + " installed. Reload VS Code to activate it.",
    "Reload Window",
  );
  if (action === "Reload Window") {
    await vscode.commands.executeCommand("workbench.action.reloadWindow");
  }
}

async function checkForUpdates(context: vscode.ExtensionContext): Promise<void> {
  const currentVersion = String(context.extension.packageJSON.version ?? "0.0.0");
  const latest = await fetchLatestReleaseManifest();
  const comparison = compareSemver(latest.manifest.version, currentVersion);

  if (comparison <= 0) {
    await vscode.window.showInformationMessage("LLMatic " + currentVersion + " is up to date.");
    return;
  }

  const action = await vscode.window.showInformationMessage(
    "LLMatic " + latest.manifest.version + " is available (installed: " + currentVersion + ").",
    "Install Update",
    "Open Release",
  );

  if (action === "Install Update") {
    await installLatestUpdate(context, latest);
  } else if (action === "Open Release") {
    await vscode.env.openExternal(vscode.Uri.parse(latest.releaseUrl));
  }
}

async function showDoctor(
  context: vscode.ExtensionContext,
  state: ExtensionState,
  output: vscode.OutputChannel,
): Promise<void> {
  const checks = await runDoctor(context, state);
  output.clear();
  output.appendLine("LLMatic Agent Runtime Doctor");
  output.appendLine("");

  for (const check of checks) {
    output.appendLine("[" + check.status + "] " + check.name + ": " + check.detail);
  }

  const failures = checks.filter((check) => check.status === "FAIL").length;
  const warnings = checks.filter((check) => check.status === "WARN").length;
  output.appendLine("");
  output.appendLine(
    failures === 0
      ? "READY" + (warnings ? " (" + warnings + " warning(s))" : "")
      : "NOT READY (" + failures + " failure(s))",
  );
  output.show(true);

  if (failures === 0) {
    await vscode.window.showInformationMessage("LLMatic Doctor: READY");
  } else {
    await vscode.window.showWarningMessage(
      "LLMatic Doctor found " + failures + " blocking issue(s). See the LLMatic output channel.",
    );
  }
}

function formatAgentEvent(event: CodingAgentEvent): string {
  if (event.type === "model") return "[MODEL] step " + event.step;
  if (event.type === "tool-start") return "[TOOL] " + event.name;
  if (event.type === "tool-result") {
    return "[" + (event.success ? "PASS" : "FAIL") + "] " + event.name;
  }
  return "[INFO] " + event.message;
}

async function confirmAutoFreeDataHandling(
  context: vscode.ExtensionContext,
  model: string,
): Promise<boolean> {
  if (model !== "kilo-auto/free") return true;

  const accepted = context.globalState.get<boolean>(AUTO_FREE_WARNING_ACCEPTED, false);
  if (accepted) return true;

  const selection = await vscode.window.showWarningMessage(
    "Auto Free may route repository snippets to third-party inference providers that can log prompts/outputs. LLMatic blocks common secret files, but do not use Auto Free for confidential source code.",
    { modal: true },
    "Continue with Auto Free",
  );

  if (selection !== "Continue with Auto Free") return false;
  await context.globalState.update(AUTO_FREE_WARNING_ACCEPTED, true);
  return true;
}

function printReviewReport(output: vscode.OutputChannel, report: CodeReviewReport): void {
  output.appendLine("Review summary: " + report.summary);
  output.appendLine(
    "Code findings: " +
      report.findings.length +
      " (" +
      report.codeBlockingCount +
      " blocking, " +
      report.nonBlockingCount +
      " non-blocking)",
  );
  output.appendLine("Review lenses: " + report.lenses.join(", "));
  output.appendLine(
    "Repository constitution: " +
      report.constitution.activeRuleCount +
      " active explicit/approved rule(s), " +
      report.constitution.blockingRuleCount +
      " blocking rule(s), " +
      report.constitution.inferredConventionCount +
      " inferred convention(s), " +
      report.constitution.proposedRuleCount +
      " proposed rule(s)",
  );
  output.appendLine(
    "Living architecture: " +
      (report.architectureImpact.baselineDetected
        ? report.architectureImpact.unresolvedCount +
          " unresolved / " +
          report.architectureImpact.requiredCount +
          " required impact area(s)"
        : "baseline not detected"),
  );
  output.appendLine("Total blocking review items: " + report.blockingCount);
  output.appendLine("");

  for (const finding of report.findings) {
    const location = finding.line ? finding.path + ":" + finding.line : finding.path;
    output.appendLine(
      "[" +
        (finding.severity === "blocking" ? "BLOCKING" : "NON-BLOCKING") +
        "][" +
        finding.lens.toUpperCase() +
        "] " +
        finding.title +
        " — " +
        location,
    );
    if (finding.ruleId) {
      output.appendLine(
        "  Rule: " + finding.ruleId + (finding.ruleSource ? " (" + finding.ruleSource + ")" : ""),
      );
    }
    output.appendLine("  " + finding.evidence);
    output.appendLine("  Fix: " + finding.recommendation);
  }

  for (const impact of report.architectureImpact.impacts) {
    output.appendLine("[" + (impact.resolved ? "SYNCED" : "BLOCKING-SYNC") + "] " + impact.area);
    output.appendLine("  Trigger: " + impact.reasons.join(", "));
    if (impact.changedResolutionPaths.length > 0) {
      output.appendLine("  Evidence: " + impact.changedResolutionPaths.join(", "));
    }
    if (!impact.resolved) {
      output.appendLine("  Required: " + impact.recommendation);
    }
  }
}

function formatReviewLoopEvent(event: ReviewLoopEvent): string {
  if (event.type === "review-start") return "[REVIEW] round " + event.round;
  if (event.type === "review-complete") {
    return "[REVIEW] " + event.blockingCount + " blocking finding(s)";
  }
  if (event.type === "fix-start") return "[FIX] round " + event.round;
  if (event.type === "validation") {
    return "[VALIDATION] " + (event.success ? "PASS" : "FAIL");
  }
  return "[INFO] " + event.message;
}

function isAnonymousFreeKiloModel(model: string): boolean {
  const normalized = model.trim().toLowerCase();
  return normalized === "kilo-auto/free" || normalized.endsWith(":free");
}

async function connectKiloGatewayInUi(
  context: vscode.ExtensionContext,
  state: ExtensionState,
  statusProvider: LlmaticStatusProvider,
): Promise<void> {
  const provider = externalConnectionProvider("kilo_gateway");
  const existing = await context.secrets.get(KILO_GATEWAY_SECRET);
  const anonymousAccepted = context.globalState.get<boolean>(KILO_ANONYMOUS_STATE, false);

  const choice = await vscode.window.showQuickPick(
    [
      {
        label: "$(globe) Get a Kilo Gateway API key",
        description: "Open Kilo in your browser",
        detail:
          "Sign in at app.kilo.ai, open your personal profile and create an API key. LLMatic will then ask you to paste it securely.",
        action: "browser" as const,
      },
      {
        label: "$(key) Paste an existing API key",
        description: existing ? "Replace the stored key" : "Store securely in VS Code",
        action: "paste" as const,
      },
      {
        label: "$(rocket) Use anonymous Auto Free",
        description: "No API key required",
        detail:
          "Available for kilo-auto/free and explicit :free models; anonymous requests are rate-limited by Kilo.",
        action: "anonymous" as const,
      },
      ...(existing
        ? [
            {
              label: "$(trash) Remove stored API key",
              description:
                "Keep Kilo Code/MCP; direct paid Gateway access will no longer use this key",
              action: "clear" as const,
            },
          ]
        : []),
    ],
    {
      title: "LLMatic: Connect Kilo Gateway",
      placeHolder: anonymousAccepted
        ? "Anonymous Auto Free is already allowed; choose another option if needed"
        : "Choose how LLMatic should access Kilo Gateway",
      ignoreFocusOut: true,
    },
  );

  if (!choice) return;

  if (choice.action === "clear") {
    await context.secrets.delete(KILO_GATEWAY_SECRET);
    state.gatewayKeyConfigured = false;
    statusProvider.update(state.health, false, state.recovery);
    await vscode.window.showInformationMessage(
      "Kilo Gateway API key removed. Auto Free can still run anonymously when enabled.",
    );
    return;
  }

  if (choice.action === "anonymous") {
    await context.globalState.update(KILO_ANONYMOUS_STATE, true);
    await vscode.window.showInformationMessage(
      "Anonymous Kilo Auto Free enabled. No API key is required for kilo-auto/free or explicit :free models.",
    );
    return;
  }

  if (choice.action === "browser") {
    if (provider.browserUrl) {
      const opened = await vscode.env.openExternal(vscode.Uri.parse(provider.browserUrl));
      if (!opened) {
        throw new Error("VS Code could not open the Kilo account page.");
      }
    }
  }

  const value = await vscode.window.showInputBox({
    title: "LLMatic: Kilo Gateway API Key",
    prompt:
      choice.action === "browser"
        ? "After creating the key in your Kilo personal profile, paste it here. Stored only in VS Code SecretStorage."
        : "Paste your Kilo Gateway API key. Stored only in VS Code SecretStorage.",
    placeHolder: "Paste Kilo Gateway API key",
    password: true,
    ignoreFocusOut: true,
  });

  if (!value?.trim()) return;

  await context.secrets.store(KILO_GATEWAY_SECRET, value.trim());
  await context.globalState.update(KILO_ANONYMOUS_STATE, false);
  state.gatewayKeyConfigured = true;
  statusProvider.update(state.health, true, state.recovery);

  await vscode.window.showInformationMessage(
    "Kilo Gateway API key stored securely. Direct LLMatic agent and review are enabled.",
  );
}

async function gatewayAccessOrPrompt(
  context: vscode.ExtensionContext,
  model: string,
  state: ExtensionState,
  statusProvider: LlmaticStatusProvider,
): Promise<GatewayAccess | undefined> {
  const existing = await context.secrets.get(KILO_GATEWAY_SECRET);
  if (existing) return { apiKey: existing, anonymous: false };

  const anonymousAllowed =
    configuration().get<boolean>("allowAnonymousKiloFree", true) && isAnonymousFreeKiloModel(model);
  if (anonymousAllowed) {
    return { anonymous: true };
  }

  const action = await vscode.window.showWarningMessage(
    "The selected Kilo model needs authenticated Gateway access. You can create an API key in the browser or paste an existing one.",
    "Connect Kilo Gateway",
    "Cancel",
  );
  if (action !== "Connect Kilo Gateway") return undefined;

  await connectKiloGatewayInUi(context, state, statusProvider);
  const apiKey = await context.secrets.get(KILO_GATEWAY_SECRET);
  if (apiKey) return { apiKey, anonymous: false };

  if (
    configuration().get<boolean>("allowAnonymousKiloFree", true) &&
    isAnonymousFreeKiloModel(model)
  ) {
    return { anonymous: true };
  }

  return undefined;
}

async function openConnectionCenter(
  context: vscode.ExtensionContext,
  state: ExtensionState,
  statusProvider: LlmaticStatusProvider,
  chatProvider: AgentChatViewProvider,
  output: vscode.OutputChannel,
): Promise<void> {
  const jira = workspaceJiraProfile(context);
  const kiloKey = await context.secrets.get(KILO_GATEWAY_SECRET);
  const selected = await vscode.window.showQuickPick(
    [
      {
        label: "$(issues) Jira",
        description: jira
          ? jira.projectKey +
            " · " +
            (jira.workMode === "assigned_only" ? "assigned to me" : "project queue")
          : "Not connected for this workspace",
        detail: "Browser OAuth or manual fallback",
        id: "jira" as const,
      },
      {
        label: "$(sparkle) Kilo Gateway",
        description: kiloKey ? "API key configured" : "Auto Free can run without a key",
        detail: "Browser-assisted API key setup, secure paste, or anonymous Auto Free",
        id: "kilo_gateway" as const,
      },
    ],
    {
      title: "LLMatic: External Connections",
      placeHolder: "Choose a service to connect or reconfigure",
      ignoreFocusOut: true,
    },
  );

  if (!selected) return;
  if (selected.id === "jira") {
    await connectJiraWorkspace(context, state, statusProvider, chatProvider, output);
  } else {
    await connectKiloGatewayInUi(context, state, statusProvider);
  }
}

async function runGatewayReview(
  context: vscode.ExtensionContext,
  state: ExtensionState,
  statusProvider: LlmaticStatusProvider,
  output: vscode.OutputChannel,
  fixLoop: boolean,
): Promise<CodeReviewReport | undefined> {
  const folder = firstWorkspaceFolder();
  if (!folder) {
    throw new Error("Open a repository workspace before running review.");
  }

  if (!state.activeWorkspace) {
    state.activeWorkspace = await attachWorkspace(context, folder);
  }

  const model =
    configuration().get<string>("agentModel", "kilo-auto/free").trim() || "kilo-auto/free";
  const gatewayAccess = await gatewayAccessOrPrompt(context, model, state, statusProvider);
  if (!gatewayAccess) return undefined;
  if (!(await confirmAutoFreeDataHandling(context, model))) return undefined;

  const root = folder.uri.fsPath;
  const config = await loadAgentConfig(root, {
    LLMATIC_HOME: context.globalStorageUri.fsPath,
  });
  let store = new WorkflowStateStore(root, config);
  const gateway = new KiloGatewayClient({ apiKey: gatewayAccess.apiKey });

  output.clear();
  output.appendLine(fixLoop ? "LLMatic Review / Fix Loop" : "LLMatic Code Review");
  output.appendLine("Model: " + model);
  output.appendLine("Workspace: " + root);
  output.appendLine("");

  if (fixLoop) {
    const current = await store.loadCurrent();
    if (!current || current.state !== "CODE_REVIEW") {
      const adHocConfig = {
        ...config,
        runtime: {
          ...config.runtime,
          stateDirectory: resolve(state.activeWorkspace.directory, "ad-hoc-review-state"),
        },
      };
      store = new WorkflowStateStore(root, adHocConfig);
      output.appendLine(
        current
          ? "[INFO] Active workflow is " +
              current.state +
              "; running this Review / Fix Loop in ad-hoc mode without changing workflow state."
          : "[INFO] No active workflow; running ad-hoc Review / Fix Loop.",
      );
    }
  }

  if (fixLoop) {
    const result = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "LLMatic review/fix loop is running",
        cancellable: false,
      },
      async (progress) =>
        runReviewFixLoop({
          root,
          config,
          store,
          gateway,
          model,
          lenses: ["general", "bug_hunter", "security"],
          maxSteps: configuration().get<number>("agentMaxSteps", 20),
          maxReviewRounds: config.workflow.maxFixAttempts,
          allowAdHoc: true,
          onEvent: (event) => {
            const line = formatReviewLoopEvent(event);
            output.appendLine(line);
            progress.report({ message: line });
          },
        }),
    );

    output.appendLine("");
    printReviewReport(output, result.review);
    output.appendLine("");
    output.appendLine("Review rounds: " + result.reviewRounds);
    output.appendLine("Fix rounds: " + result.fixRounds);
    output.show(true);

    await vscode.window.showInformationMessage(
      "LLMatic review/fix loop completed with " +
        result.review.blockingCount +
        " blocking finding(s).",
    );
    return result.review;
  }

  const report = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "LLMatic code review is running",
      cancellable: false,
    },
    () =>
      runCodeReview({
        root,
        config,
        store,
        gateway,
        model,
        lenses: ["general", "bug_hunter", "security"],
      }),
  );

  printReviewReport(output, report);
  output.show(true);

  await vscode.window.showInformationMessage(
    "LLMatic review: " +
      report.blockingCount +
      " blocking / " +
      report.nonBlockingCount +
      " non-blocking finding(s).",
  );
  return report;
}

async function runAgentChatTurn(
  context: vscode.ExtensionContext,
  state: ExtensionState,
  statusProvider: LlmaticStatusProvider,
  chatProvider: AgentChatViewProvider,
  output: vscode.OutputChannel,
  instruction: string,
): Promise<void> {
  const folder = firstWorkspaceFolder();
  if (!folder) {
    throw new Error("Open a repository workspace before using Agent Chat.");
  }

  if (!state.activeWorkspace) {
    state.activeWorkspace = await attachWorkspace(context, folder);
  }

  const model =
    configuration().get<string>("agentModel", "kilo-auto/free").trim() || "kilo-auto/free";
  const gatewayAccess = await gatewayAccessOrPrompt(context, model, state, statusProvider);
  if (!gatewayAccess) return;
  if (!(await confirmAutoFreeDataHandling(context, model))) return;

  if (!state.recovery) {
    await refreshWorkspaceRecovery(context, state, statusProvider, chatProvider, output, false);
  }

  const root = folder.uri.fsPath;
  const runtimeConfig = await loadAgentConfig(root, {
    LLMATIC_HOME: context.globalStorageUri.fsPath,
  });
  const store = new WorkflowStateStore(root, runtimeConfig);
  const gateway = new KiloGatewayClient({ apiKey: gatewayAccess.apiKey });
  const maxSteps = configuration().get<number>("agentMaxSteps", 20);

  chatProvider.setBusy(true);
  output.appendLine("");
  output.appendLine("[CHAT] User: " + instruction);

  try {
    const result = await runCodingAgent({
      root,
      config: runtimeConfig,
      store,
      gateway,
      instruction,
      history: chatProvider.conversationHistory(),
      context: state.recovery ? workspaceRecoveryContext(state.recovery) : undefined,
      environment: await taskRecoveryEnvironment(context, state),
      model,
      maxSteps,
      onEvent: (event) => {
        const line = formatAgentEvent(event);
        output.appendLine(line);
        chatProvider.appendActivity(line, event.type === "tool-result" ? event.success : undefined);
      },
    });

    output.appendLine("[CHAT] LLMatic: " + result.finalText);
    chatProvider.appendAssistant(result.finalText);

    await refreshWorkspaceRecovery(context, state, statusProvider, chatProvider, output, true);
  } finally {
    chatProvider.setBusy(false);
  }
}

function writeBootstrapReport(output: vscode.OutputChannel, report: BootstrapReport): void {
  output.clear();
  output.appendLine("LLMatic Workspace Bootstrap");
  output.appendLine("Repository: " + report.root);
  output.appendLine("Ready: " + (report.ready ? "yes" : "no"));
  output.appendLine("");

  for (const item of report.requirements) {
    const marker = item.installed ? "PASS" : item.level === "required" ? "FAIL" : "WARN";
    const installer = !item.installed && item.installerAvailable ? " [auto-install available]" : "";
    output.appendLine(
      "[" + marker + "] " + item.name + " (" + item.level + "): " + item.reason + installer,
    );
  }

  if (report.unsupportedPackageManager) {
    output.appendLine("");
    output.appendLine("[WARN] Package manager: " + report.unsupportedPackageManager);
  }
}

async function bootstrapWorkspace(
  context: vscode.ExtensionContext,
  state: ExtensionState,
  statusBar: vscode.StatusBarItem,
  output: vscode.OutputChannel,
): Promise<void> {
  const folder = firstWorkspaceFolder();
  if (!folder) {
    await vscode.window.showWarningMessage("Open a workspace before bootstrapping LLMatic.");
    return;
  }

  state.activeWorkspace = await attachWorkspace(context, folder);
  let report = await inspectBootstrap(state.activeWorkspace.root, state.activeWorkspace.config);
  writeBootstrapReport(output, report);
  output.show(true);

  const autoInstallable = report.requirements.filter(
    (item) => !item.installed && item.installerAvailable,
  );

  if (autoInstallable.length > 0) {
    const names = autoInstallable.map((item) => item.name).join(", ");
    const action = await vscode.window.showInformationMessage(
      "LLMatic can install registered missing tools: " + names + ".",
      { modal: true },
      "Install",
    );

    if (action === "Install") {
      const result = await remediateBootstrap(
        state.activeWorkspace.root,
        state.activeWorkspace.config,
        autoInstallable.map((item) => item.id),
        { approved: true },
      );

      report = result.report;
      writeBootstrapReport(output, report);
      output.appendLine("");

      for (const installation of result.installations) {
        output.appendLine(
          "[INSTALL] " +
            installation.tool.name +
            ": " +
            (installation.changed ? "installed" : "already available"),
        );
      }
    }
  }

  const kilo = await connectKilo(context);
  state.kiloConnected = kilo.connected;
  state.kiloReloadRecommended = kilo.changed;
  state.lastError = undefined;
  updateStatusBar(statusBar, state);

  const missingRequired = report.requirements.filter(
    (item) => item.level === "required" && !item.installed,
  );

  if (missingRequired.length > 0) {
    await vscode.window.showWarningMessage(
      "LLMatic bootstrap needs manual setup for: " +
        missingRequired.map((item) => item.name).join(", ") +
        ". See the LLMatic output channel.",
    );
    return;
  }

  if (kilo.changed) {
    const action = await vscode.window.showInformationMessage(
      "LLMatic workspace is ready. Kilo MCP configuration changed.",
      "Reload Window",
    );
    if (action === "Reload Window") {
      await vscode.commands.executeCommand("workbench.action.reloadWindow");
    }
  } else {
    await vscode.window.showInformationMessage("LLMatic workspace bootstrap is ready.");
  }
}

async function getReady(
  context: vscode.ExtensionContext,
  state: ExtensionState,
  statusBar: vscode.StatusBarItem,
  statusProvider: LlmaticStatusProvider,
  output: vscode.OutputChannel,
): Promise<void> {
  const folder = firstWorkspaceFolder();
  if (!folder) {
    await vscode.window.showWarningMessage(
      "Open a repository workspace before running LLMatic: Get Ready.",
    );
    return;
  }

  output.clear();
  output.appendLine("LLMatic Get Ready");
  output.appendLine("Repository: " + folder.uri.fsPath);
  output.appendLine("");

  state.activeWorkspace = await attachWorkspace(context, folder);
  output.appendLine("[PASS] Workspace attached outside the repository.");

  let runtime = await inspectExtensionRuntime(context);
  if (!runtime.healthy) {
    output.appendLine("[REPAIR] Runtime integrity failed; reinstalling bundled runtime.");
    runtime = await installRuntimeBundle({
      bundlePath: bundledMcpServerPath(context),
      manifestPath: bundledRuntimeManifestPath(context),
      runtimeHome: context.globalStorageUri.fsPath,
      force: true,
    });
  } else {
    output.appendLine("[PASS] Runtime integrity verified.");
  }
  state.runtime = runtime;

  let bootstrap = await inspectBootstrap(state.activeWorkspace.root, state.activeWorkspace.config);
  const installableRequired = bootstrap.requirements.filter(
    (item) => item.level === "required" && !item.installed && item.installerAvailable,
  );

  if (installableRequired.length > 0) {
    const action = await vscode.window.showInformationMessage(
      "LLMatic can install required registered tools: " +
        installableRequired.map((item) => item.name).join(", ") +
        ".",
      { modal: true },
      "Install Required Tools",
    );

    if (action === "Install Required Tools") {
      const remediation = await remediateBootstrap(
        state.activeWorkspace.root,
        state.activeWorkspace.config,
        installableRequired.map((item) => item.id),
        { approved: true },
      );
      bootstrap = remediation.report;
      for (const installation of remediation.installations) {
        output.appendLine(
          "[INSTALL] " +
            installation.tool.name +
            ": " +
            (installation.changed ? "installed" : "already available"),
        );
      }
    }
  }

  state.bootstrap = bootstrap;
  const missingRequired = bootstrap.requirements.filter(
    (item) => item.level === "required" && !item.installed,
  );
  for (const item of missingRequired) {
    output.appendLine("[SETUP] Required tool missing: " + item.name + " — " + item.reason);
  }

  const kiloInstalled = Boolean(vscode.extensions.getExtension(KILO_EXTENSION_ID));
  if (!kiloInstalled && configuration().get<boolean>("autoConnectKilo", true)) {
    output.appendLine("[SETUP] Kilo Code is not installed.");
    const action = await vscode.window.showInformationMessage(
      "Kilo Code is required by the current LLMatic auto-connect configuration.",
      "Open Kilo Code Extension",
    );
    if (action === "Open Kilo Code Extension") {
      await vscode.commands.executeCommand(
        "workbench.extensions.search",
        "@id:" + KILO_EXTENSION_ID,
      );
    }
  } else if (kiloInstalled) {
    const kilo = await connectKilo(context);
    state.kiloConnected = kilo.connected;
    state.kiloReloadRecommended = kilo.changed;
    output.appendLine(
      "[PASS] Kilo MCP: " + (kilo.changed ? "registration reconciled" : "already healthy"),
    );
  }

  const health = await evaluateExtensionHealth(context, state);
  output.appendLine("");
  writeHealthReport(output, health);
  output.show(true);
  updateStatusBar(statusBar, state);
  statusProvider.update(state.health, state.gatewayKeyConfigured);

  if (health.status === "READY") {
    await context.workspaceState.update("llmatic.onboardingVersion", ONBOARDING_VERSION);
    const action = state.kiloReloadRecommended
      ? await vscode.window.showInformationMessage(
          "LLMatic is READY. Kilo MCP changed and a window reload is recommended.",
          "Reload Window",
        )
      : await vscode.window.showInformationMessage("LLMatic is READY.");

    if (action === "Reload Window") {
      await vscode.commands.executeCommand("workbench.action.reloadWindow");
    }
    return;
  }

  await vscode.window.showWarningMessage(
    "LLMatic is " +
      health.status.replace("_", " ") +
      ". See the LLMatic output and Runtime Status view.",
  );
}

interface DiscoveryQuickPickItem extends vscode.QuickPickItem {
  action: "option" | "recommended" | "delegate" | "custom";
  value?: string;
}

function discoveryChoiceItems(question: DiscoveryQuestion): DiscoveryQuickPickItem[] {
  const items: DiscoveryQuickPickItem[] = question.options.map((option) => ({
    label:
      option.id === question.recommendation.optionId
        ? "$(star-full) " + option.label
        : option.label,
    description: option.id === question.recommendation.optionId ? "Recommended" : undefined,
    detail: option.description,
    action: "option",
    value: option.id,
  }));

  items.push(
    {
      label: "$(question) Not sure — explain recommendation",
      description: "Review the best-practice rationale first",
      detail: question.recommendation.rationale,
      action: "recommended",
    },
    {
      label: "$(sparkle) Let LLMatic decide",
      description: "Use the recommended option and record delegated rationale",
      detail: question.recommendation.rationale,
      action: "delegate",
    },
  );

  if (question.customAllowed) {
    items.push({
      label: "$(edit) Custom…",
      description: "Enter a project-specific answer",
      action: "custom",
    });
  }

  return items;
}

async function answerDiscoveryInUi(
  workspaceDirectory: string,
  session: DiscoverySession,
  question: DiscoveryQuestion,
): Promise<DiscoverySession | undefined> {
  const choice = await vscode.window.showQuickPick(discoveryChoiceItems(question), {
    title: "LLMatic Discovery — " + question.title,
    placeHolder: question.prompt,
    ignoreFocusOut: true,
  });

  if (!choice) return undefined;

  if (choice.action === "custom") {
    const value = await vscode.window.showInputBox({
      title: "LLMatic Discovery — " + question.title,
      prompt: question.prompt,
      placeHolder: "Enter a custom project-specific answer",
      ignoreFocusOut: true,
      validateInput: (input) => (input.trim() ? undefined : "A custom answer is required."),
    });

    if (!value?.trim()) return undefined;

    return answerDiscoveryQuestion(workspaceDirectory, session, question.id, {
      mode: "custom",
      value: value.trim(),
    });
  }

  if (choice.action === "recommended") {
    const recommended = question.options.find(
      (option) => option.id === question.recommendation.optionId,
    );
    const action = await vscode.window.showInformationMessage(
      (recommended ? "Recommended: " + recommended.label + "\n\n" : "") +
        question.recommendation.rationale,
      { modal: true },
      "Use Recommendation",
      "Choose Another",
    );

    if (action === "Choose Another") {
      return answerDiscoveryInUi(workspaceDirectory, session, question);
    }

    if (action !== "Use Recommendation") return undefined;

    return answerDiscoveryQuestion(workspaceDirectory, session, question.id, {
      mode: "recommended",
    });
  }

  if (choice.action === "delegate") {
    return answerDiscoveryQuestion(workspaceDirectory, session, question.id, {
      mode: "delegate",
    });
  }

  return answerDiscoveryQuestion(workspaceDirectory, session, question.id, {
    mode: "option",
    value: choice.value,
  });
}

function writeDiscoverySummary(
  output: vscode.OutputChannel,
  workspaceDirectory: string,
  session: DiscoverySession,
): void {
  output.clear();
  output.appendLine("LLMatic Project Discovery");
  output.appendLine("");
  output.appendLine(discoverySummary(session));
  output.appendLine("");
  output.appendLine("Private state: " + discoverySessionPath(workspaceDirectory));
  output.appendLine("Repository files changed: none");
  output.show(true);
}

async function startProjectDiscovery(
  context: vscode.ExtensionContext,
  state: ExtensionState,
  output: vscode.OutputChannel,
  resumeExisting = false,
): Promise<void> {
  const folder = firstWorkspaceFolder();
  if (!folder) {
    await vscode.window.showWarningMessage(
      "Open a repository workspace before starting project discovery.",
    );
    return;
  }

  if (!state.activeWorkspace) {
    state.activeWorkspace = await attachWorkspace(context, folder);
  }

  const greenfield = await isGreenfieldRepository(folder.uri.fsPath);
  if (!greenfield) {
    const proceed = await vscode.window.showWarningMessage(
      "This repository is not empty. Discovery will remain private and will not change tracked project files, but recommendations may describe a new architecture.",
      { modal: true },
      "Continue Discovery",
    );

    if (proceed !== "Continue Discovery") return;
  }

  const workspaceDirectory = state.activeWorkspace.directory;
  let session = await loadDiscoverySession(workspaceDirectory);

  if (session && !resumeExisting) {
    const action = await vscode.window.showQuickPick(
      [
        {
          label: "$(debug-continue) Resume discovery",
          description:
            Object.keys(session.answers).length + " decision(s) recorded — " + session.status,
          value: "resume",
        },
        {
          label: "$(refresh) Restart discovery",
          description: "Replace the private discovery session with a new one",
          value: "restart",
        },
      ],
      {
        title: "LLMatic Project Discovery",
        placeHolder: "A private discovery session already exists.",
        ignoreFocusOut: true,
      },
    );

    if (!action) return;
    if (action.value === "restart") session = undefined;
  }

  if (!session) {
    const idea = await vscode.window.showInputBox({
      title: "LLMatic Project Discovery",
      prompt: "What do you want to build? Describe the problem/product in your own words.",
      placeHolder: "Example: A B2B SaaS that analyzes property development constraints",
      ignoreFocusOut: true,
      validateInput: (input) => (input.trim() ? undefined : "Describe the project idea first."),
    });

    if (!idea?.trim()) return;

    session = await createDiscoverySession(folder.uri.fsPath, workspaceDirectory, idea.trim());
  }

  while (session.status === "in_progress") {
    const question = nextDiscoveryQuestion(session);
    if (!question) break;

    const updated = await answerDiscoveryInUi(workspaceDirectory, session, question);

    if (!updated) {
      writeDiscoverySummary(output, workspaceDirectory, session);
      await vscode.window.showInformationMessage(
        "Discovery paused. Your answers were saved outside the repository.",
      );
      return;
    }

    session = updated;
  }

  writeDiscoverySummary(output, workspaceDirectory, session);

  if (session.status === "ready_for_planning") {
    const action = await vscode.window.showInformationMessage(
      "Project discovery is complete and ready for planning. No tracked repository files were changed.",
      "Generate Project Plan",
    );

    if (action === "Generate Project Plan") {
      await vscode.commands.executeCommand("llmatic.generatePlan");
    }
  }
}

interface PlanQuickPickItem extends vscode.QuickPickItem {
  relativePath?: string;
  action?: "reveal";
}

function writePlanSummary(
  output: vscode.OutputChannel,
  manifest: ProjectPlanManifest,
  planDirectory: string,
): void {
  output.clear();
  output.appendLine("LLMatic Project Plan");
  output.appendLine("");
  output.appendLine("Plan: " + manifest.planId);
  output.appendLine("Status: " + manifest.status);
  output.appendLine("Artifacts: " + manifest.artifactCount);
  output.appendLine("Tasks: " + manifest.taskCount);
  output.appendLine("Private plan directory: " + planDirectory);
  output.appendLine("Repository files changed: none");
  output.show(true);
}

async function generateProjectPlanInUi(
  context: vscode.ExtensionContext,
  state: ExtensionState,
  output: vscode.OutputChannel,
): Promise<void> {
  const folder = firstWorkspaceFolder();
  if (!folder) {
    await vscode.window.showWarningMessage(
      "Open the project workspace before generating a project plan.",
    );
    return;
  }

  if (!state.activeWorkspace) {
    state.activeWorkspace = await attachWorkspace(context, folder);
  }

  const workspaceDirectory = state.activeWorkspace.directory;
  const discovery = await loadDiscoverySession(workspaceDirectory);

  if (!discovery || discovery.status !== "ready_for_planning") {
    const action = await vscode.window.showInformationMessage(
      "Project discovery must be completed before LLMatic can generate the engineering plan.",
      "Start / Resume Discovery",
    );

    if (action === "Start / Resume Discovery") {
      await vscode.commands.executeCommand("llmatic.startDiscovery");
    }
    return;
  }

  const current = await loadCurrentProjectPlan(workspaceDirectory);
  if (current) {
    const action = await vscode.window.showWarningMessage(
      "A private project-plan draft already exists. Generating again creates a new version and preserves the current draft.",
      { modal: true },
      "Generate New Draft",
      "Review Current",
    );

    if (action === "Review Current") {
      await vscode.commands.executeCommand("llmatic.reviewPlan");
      return;
    }

    if (action !== "Generate New Draft") return;
  }

  const pendingChangeRequest = await loadProjectChangeRequest(workspaceDirectory);

  const result = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "LLMatic is generating the private project plan",
      cancellable: false,
    },
    () =>
      generateProjectPlan(workspaceDirectory, discovery, {
        changeRequest: pendingChangeRequest?.text,
      }),
  );

  writePlanSummary(output, result.manifest, result.current.planDirectory);

  const action = await vscode.window.showInformationMessage(
    "Project plan draft generated privately. No tracked repository files were changed.",
    "Review Plan",
    "Reveal Plan Folder",
  );

  if (action === "Review Plan") {
    await vscode.commands.executeCommand("llmatic.reviewPlan");
  } else if (action === "Reveal Plan Folder") {
    await vscode.commands.executeCommand(
      "revealFileInOS",
      vscode.Uri.file(result.current.manifestPath),
    );
  }
}

async function reviewProjectPlanInUi(
  context: vscode.ExtensionContext,
  state: ExtensionState,
  output: vscode.OutputChannel,
): Promise<void> {
  const folder = firstWorkspaceFolder();
  if (!folder) {
    await vscode.window.showWarningMessage(
      "Open the project workspace to review its LLMatic plan.",
    );
    return;
  }

  if (!state.activeWorkspace) {
    state.activeWorkspace = await attachWorkspace(context, folder);
  }

  const workspaceDirectory = state.activeWorkspace.directory;
  const current = await loadCurrentProjectPlan(workspaceDirectory);
  const manifest = current
    ? await loadProjectPlanManifest(workspaceDirectory, current.planId)
    : undefined;

  if (!current || !manifest) {
    const action = await vscode.window.showInformationMessage(
      "No private project-plan draft exists for this workspace.",
      "Generate Plan",
    );

    if (action === "Generate Plan") {
      await vscode.commands.executeCommand("llmatic.generatePlan");
    }
    return;
  }

  writePlanSummary(output, manifest, current.planDirectory);

  const items: PlanQuickPickItem[] = manifest.artifacts.map((artifact) => ({
    label: artifact.title,
    description: artifact.relativePath,
    detail: artifact.kind === "json" ? "Structured planning artifact" : "Planning document",
    relativePath: artifact.relativePath,
  }));

  items.push({
    label: "$(folder-opened) Reveal plan folder",
    description: current.planDirectory,
    action: "reveal",
  });

  const selected = await vscode.window.showQuickPick(items, {
    title: "LLMatic Project Plan — " + manifest.planId,
    placeHolder:
      "Review a private planning artifact before approval and repository materialization.",
    ignoreFocusOut: true,
  });

  if (!selected) return;

  if (selected.action === "reveal") {
    await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(current.manifestPath));
    return;
  }

  if (!selected.relativePath) return;

  const document = await vscode.workspace.openTextDocument(
    vscode.Uri.file(resolve(current.planDirectory, selected.relativePath)),
  );
  await vscode.window.showTextDocument(document, {
    preview: true,
    preserveFocus: false,
  });
}

async function showProjectDiscovery(
  context: vscode.ExtensionContext,
  state: ExtensionState,
  output: vscode.OutputChannel,
): Promise<void> {
  const folder = firstWorkspaceFolder();
  if (!folder) {
    await vscode.window.showWarningMessage("Open the project workspace to view discovery state.");
    return;
  }

  if (!state.activeWorkspace) {
    state.activeWorkspace = await attachWorkspace(context, folder);
  }

  const session = await loadDiscoverySession(state.activeWorkspace.directory);
  if (!session) {
    const action = await vscode.window.showInformationMessage(
      "No project discovery session exists for this workspace.",
      "Start Discovery",
    );

    if (action === "Start Discovery") {
      await vscode.commands.executeCommand("llmatic.startDiscovery");
    }
    return;
  }

  writeDiscoverySummary(output, state.activeWorkspace.directory, session);
}

interface PlanReviewAction extends vscode.QuickPickItem {
  action: "artifacts" | "edit" | "regenerate" | "changes" | "approve";
}

async function ensurePlanningWorkspace(
  context: vscode.ExtensionContext,
  state: ExtensionState,
): Promise<{
  folder: vscode.WorkspaceFolder;
  workspace: ManagedWorkspace;
}> {
  const folder = firstWorkspaceFolder();
  if (!folder) {
    throw new Error("Open the project workspace first.");
  }

  if (!state.activeWorkspace) {
    state.activeWorkspace = await attachWorkspace(context, folder);
  }

  return {
    folder,
    workspace: state.activeWorkspace,
  };
}

async function editProjectDecisionsInUi(
  context: vscode.ExtensionContext,
  state: ExtensionState,
  output: vscode.OutputChannel,
): Promise<void> {
  const { workspace } = await ensurePlanningWorkspace(context, state);
  const session = await loadDiscoverySession(workspace.directory);

  if (!session) {
    await vscode.window.showInformationMessage(
      "No discovery session exists. Start project discovery first.",
    );
    return;
  }

  const answered = answeredDiscoveryQuestions(session);
  if (answered.length === 0) {
    await vscode.window.showInformationMessage("No discovery decisions have been answered yet.");
    return;
  }

  const selected = await vscode.window.showQuickPick(
    answered.map((item) => ({
      label: item.title,
      description: item.answer.label,
      detail: item.answer.source + (item.answer.rationale ? " — " + item.answer.rationale : ""),
      questionId: item.id,
    })),
    {
      title: "LLMatic — Edit Project Decisions",
      placeHolder: "Changing this decision clears it and all dependent later decisions.",
      ignoreFocusOut: true,
    },
  );

  if (!selected) return;

  const confirmation = await vscode.window.showWarningMessage(
    "Reopen '" +
      selected.label +
      "'? This invalidates any existing approval and clears this decision plus later dependent discovery answers.",
    { modal: true },
    "Edit Decision",
  );

  if (confirmation !== "Edit Decision") return;

  await invalidateProjectApproval(workspace.directory, "Discovery decisions reopened by the user.");
  await reopenDiscoveryAt(workspace.directory, session, selected.questionId);

  await startProjectDiscovery(context, state, output, true);
}

async function requestProjectPlanChangesInUi(
  context: vscode.ExtensionContext,
  state: ExtensionState,
): Promise<void> {
  const { workspace } = await ensurePlanningWorkspace(context, state);

  const text = await vscode.window.showInputBox({
    title: "LLMatic — Request Project Plan Changes",
    prompt:
      "Describe the change you want recorded before approval. Structural decisions should use Edit Project Decisions.",
    placeHolder: "Example: Keep the MVP single-region and defer audit export to a later phase.",
    ignoreFocusOut: true,
    validateInput: (value) => (value.trim() ? undefined : "Describe the requested plan change."),
  });

  if (!text?.trim()) return;

  await requestProjectPlanChanges(workspace.directory, text.trim());

  await vscode.window.showInformationMessage(
    "Plan change request saved privately and any previous approval invalidated. Review/edit decisions and generate a new draft before approval.",
    "Review Plan",
  );
}

async function approveAndInitializeProjectInUi(
  context: vscode.ExtensionContext,
  state: ExtensionState,
  output: vscode.OutputChannel,
): Promise<void> {
  const { folder, workspace } = await ensurePlanningWorkspace(context, state);

  const current = await loadCurrentProjectPlan(workspace.directory);
  const manifest = current
    ? await loadProjectPlanManifest(workspace.directory, current.planId)
    : undefined;

  if (!current || !manifest) {
    await vscode.window.showInformationMessage(
      "Generate and review a project plan before approval.",
      "Generate Plan",
    );
    return;
  }

  const status = await planApprovalStatus(workspace.directory);
  const digest = status.currentDigest ?? "Digest unavailable until the plan can be verified.";

  const confirmation = await vscode.window.showWarningMessage(
    [
      "Approve this exact project plan and initialize the repository?",
      "",
      "Plan: " + current.planId,
      "SHA-256: " + digest,
      "Artifacts: " + manifest.artifactCount,
      "Tasks: " + manifest.taskCount,
      "",
      "This will create tracked planning docs, TASKS.md and the approved scaffold, verify required foundation tools, and select the first unblocked task.",
      "",
      "It will not push Git, create/merge a PR, mutate a remote database, or deploy.",
    ].join("\n"),
    { modal: true },
    "Approve & Initialize",
  );

  if (confirmation !== "Approve & Initialize") return;

  const approval = await approveCurrentProjectPlan(workspace.directory);

  const runtimeConfig = await loadAgentConfig(folder.uri.fsPath, {
    LLMATIC_HOME: context.globalStorageUri.fsPath,
  });

  const result = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "LLMatic is initializing the approved project",
      cancellable: false,
    },
    () => initializeApprovedProject(folder.uri.fsPath, workspace.directory, runtimeConfig),
  );

  output.clear();
  output.appendLine("LLMatic Project Initialization");
  output.appendLine("");
  output.appendLine("Plan: " + approval.planId);
  output.appendLine("SHA-256: " + approval.planDigest);
  output.appendLine("State: " + result.lifecycle.state);
  output.appendLine("Materialized planning files: " + result.materializedFiles.length);
  output.appendLine("Scaffold files: " + result.scaffoldFiles.length);
  output.appendLine("Next task: " + result.nextTaskKey);
  output.appendLine("Workflow: " + result.workflow.state);
  output.show(true);

  await vscode.window.showInformationMessage(
    "Approved project initialization completed. " +
      result.nextTaskKey +
      " is selected and ready for implementation.",
  );
}

async function projectPlanReviewInUi(
  context: vscode.ExtensionContext,
  state: ExtensionState,
  output: vscode.OutputChannel,
): Promise<void> {
  const { workspace } = await ensurePlanningWorkspace(context, state);
  const current = await loadCurrentProjectPlan(workspace.directory);

  if (!current) {
    const action = await vscode.window.showInformationMessage(
      "No private project-plan draft exists.",
      "Generate Plan",
    );
    if (action === "Generate Plan") {
      await vscode.commands.executeCommand("llmatic.generatePlan");
    }
    return;
  }

  const approval = await planApprovalStatus(workspace.directory);
  const actions: PlanReviewAction[] = [
    {
      label: "$(preview) Review plan artifacts",
      description: "Inspect the current private plan",
      action: "artifacts",
    },
    {
      label: "$(edit) Edit decisions",
      description: "Reopen discovery from a selected decision",
      action: "edit",
    },
    {
      label: "$(refresh) Regenerate plan",
      description: "Create a new versioned draft from current discovery decisions",
      action: "regenerate",
    },
    {
      label: "$(comment-discussion) Request changes",
      description: "Record a private plan change request and invalidate approval",
      action: "changes",
    },
    {
      label: "$(verified-filled) Approve & Initialize",
      description: approval.verified
        ? "Current digest is already approved; initialize exact plan"
        : "Human approval required before repository materialization",
      detail: approval.reason,
      action: "approve",
    },
  ];

  const selected = await vscode.window.showQuickPick(actions, {
    title: "LLMatic Plan Review — " + current.planId,
    placeHolder: "Repository mutation remains blocked until Approve & Initialize.",
    ignoreFocusOut: true,
  });

  if (!selected) return;

  switch (selected.action) {
    case "artifacts":
      await reviewProjectPlanInUi(context, state, output);
      break;
    case "edit":
      await editProjectDecisionsInUi(context, state, output);
      break;
    case "regenerate":
      await vscode.commands.executeCommand("llmatic.generatePlan");
      break;
    case "changes":
      await requestProjectPlanChangesInUi(context, state);
      break;
    case "approve":
      await approveAndInitializeProjectInUi(context, state, output);
      break;
  }
}

async function offerOnboarding(
  context: vscode.ExtensionContext,
  state: ExtensionState,
): Promise<void> {
  if (!firstWorkspaceFolder()) return;
  if (state.health?.status === "READY") return;

  const seen = context.workspaceState.get<number>("llmatic.onboardingVersion", 0);
  if (seen >= ONBOARDING_VERSION) return;

  await context.workspaceState.update("llmatic.onboardingVersion", ONBOARDING_VERSION);
  const action = await vscode.window.showInformationMessage(
    "LLMatic needs setup for this workspace. Get Ready can configure the external runtime without adding LLMatic files to the repository.",
    "Get Ready",
  );

  if (action === "Get Ready") {
    await vscode.commands.executeCommand("llmatic.getReady");
  }
}

function ruleLabel(rule: ConstitutionEntry): string {
  const source = rule.source.path + (rule.source.line ? ":" + String(rule.source.line) : "");
  return rule.id + " · " + rule.kind.replaceAll("_", " ") + " · " + rule.strength + " · " + source;
}

async function generatePrDraftInUi(
  context: vscode.ExtensionContext,
  state: ExtensionState,
  statusProvider: LlmaticStatusProvider,
  chatProvider: AgentChatViewProvider,
  output: vscode.OutputChannel,
): Promise<void> {
  const folder = firstWorkspaceFolder();
  if (!folder) {
    await vscode.window.showWarningMessage(
      "Open a repository workspace before generating a PR draft.",
    );
    return;
  }

  if (!state.activeWorkspace) {
    state.activeWorkspace = await attachWorkspace(context, folder);
  }

  if (!state.recovery) {
    await refreshWorkspaceRecovery(context, state, statusProvider, chatProvider, output, false);
  }

  const config = await loadAgentConfig(folder.uri.fsPath, {
    LLMATIC_HOME: context.globalStorageUri.fsPath,
  });
  const store = new WorkflowStateStore(folder.uri.fsPath, config);
  const workflow = await store.loadCurrent();
  const review = await loadLatestReviewReport(folder.uri.fsPath, config);
  const recovery = state.recovery;

  const draft = buildPullRequestDraft({
    branch: recovery?.git.branch,
    base: recovery?.pullRequest?.pullRequest.baseRefName,
    task: recovery?.task ?? recovery?.nextTask,
    workflow,
    review,
    changedFiles: review?.changedFiles,
  });

  const document = await vscode.workspace.openTextDocument({
    language: "markdown",
    content: "# " + draft.title + "\n\n" + draft.body,
  });
  await vscode.window.showTextDocument(document, {
    preview: false,
  });
}

async function showRepositoryRulesInUi(
  context: vscode.ExtensionContext,
  state: ExtensionState,
  statusProvider: LlmaticStatusProvider,
  chatProvider: AgentChatViewProvider,
  output: vscode.OutputChannel,
): Promise<void> {
  if (!state.recovery) {
    await refreshWorkspaceRecovery(context, state, statusProvider, chatProvider, output, false);
  }

  const constitution = state.recovery?.constitution;
  if (!constitution) {
    await vscode.window.showWarningMessage(
      "Repository rules are unavailable until a repository workspace is mapped.",
    );
    return;
  }

  const items = constitution.rules.map((rule) => ({
    label:
      (rule.status === "proposed"
        ? "$(question) "
        : rule.strength === "blocking"
          ? "$(lock) "
          : "$(law) ") + rule.text,
    description: ruleLabel(rule),
    detail: rule.rationale,
    rule,
  }));

  if (items.length === 0) {
    await vscode.window.showInformationMessage(
      "No repository rules or inferred conventions were found.",
    );
    return;
  }

  await vscode.window.showQuickPick(items, {
    title: "LLMatic Repository Constitution",
    placeHolder:
      constitution.counts.explicitRule +
      " explicit · " +
      constitution.counts.approvedRule +
      " approved · " +
      constitution.counts.inferredConvention +
      " inferred · " +
      constitution.counts.proposedRule +
      " proposed",
    matchOnDescription: true,
    matchOnDetail: true,
    ignoreFocusOut: true,
  });
}

async function reviewRepositoryRuleProposalsInUi(
  context: vscode.ExtensionContext,
  state: ExtensionState,
  statusProvider: LlmaticStatusProvider,
  chatProvider: AgentChatViewProvider,
  output: vscode.OutputChannel,
): Promise<void> {
  if (!state.recovery) {
    await refreshWorkspaceRecovery(context, state, statusProvider, chatProvider, output, false);
  }

  const proposals =
    state.recovery?.constitution.rules.filter(
      (rule) => rule.kind === "proposed_rule" && rule.status === "proposed",
    ) ?? [];

  if (proposals.length === 0) {
    await vscode.window.showInformationMessage(
      "There are no repository rule proposals awaiting review.",
    );
    return;
  }

  const selected = await vscode.window.showQuickPick(
    proposals.map((rule) => ({
      label: "$(question) " + rule.text,
      description: ruleLabel(rule),
      detail: rule.rationale,
      rule,
    })),
    {
      title: "Review Repository Rule Proposals",
      placeHolder: "A proposal is not enforced until you explicitly approve it.",
      matchOnDescription: true,
      matchOnDetail: true,
      ignoreFocusOut: true,
    },
  );

  if (!selected) return;

  const decision = await vscode.window.showWarningMessage(
    selected.rule.text +
      "\n\nReason: " +
      (selected.rule.rationale ?? "No rationale supplied.") +
      "\n\nSource: " +
      selected.rule.source.path +
      (selected.rule.source.line ? ":" + selected.rule.source.line : ""),
    { modal: true },
    "Approve Rule",
    "Reject Rule",
  );

  if (decision !== "Approve Rule" && decision !== "Reject Rule") return;

  if (!state.activeWorkspace) {
    const folder = firstWorkspaceFolder();
    if (!folder) return;
    state.activeWorkspace = await attachWorkspace(context, folder);
  }

  const config = await loadAgentConfig(state.activeWorkspace.root, {
    LLMATIC_HOME: context.globalStorageUri.fsPath,
  });
  await decideRepositoryRuleProposal(
    state.activeWorkspace.root,
    config,
    selected.rule.id,
    decision === "Approve Rule" ? "approved" : "rejected",
  );

  await refreshWorkspaceRecovery(context, state, statusProvider, chatProvider, output, true);

  await vscode.window.showInformationMessage(
    decision === "Approve Rule"
      ? "Repository rule approved and now active in review policy."
      : "Repository rule proposal rejected.",
  );
}

async function showStatus(context: vscode.ExtensionContext, state: ExtensionState): Promise<void> {
  const kiloInstalled = Boolean(vscode.extensions.getExtension(KILO_EXTENSION_ID));
  const kiloServer = kiloInstalled ? await readGlobalKiloLlmaticServer(homedir()) : undefined;
  const hasGatewayKey = Boolean(await context.secrets.get(KILO_GATEWAY_SECRET));

  const health = state.health ?? (await evaluateExtensionHealth(context, state));
  const lines = [
    "Health: " + health.status,
    state.activeWorkspace ? "Workspace: " + state.activeWorkspace.root : "Workspace: not attached",
    state.activeWorkspace ? "Workspace data: " + state.activeWorkspace.directory : undefined,
    state.runtime
      ? "Runtime: " +
        (state.runtime.healthy ? state.runtime.runtimeVersion + " verified" : "needs repair")
      : "Runtime: unknown",
    "Kilo Code: " + (kiloInstalled ? "installed" : "not installed"),
    "Kilo MCP: " + (kiloServer ? "configured" : "not configured"),
    "Kilo Gateway key: " + (hasGatewayKey ? "stored securely" : "not stored"),
    state.recovery
      ? "Repository map: " +
        state.recovery.repository.fileCount +
        " files / " +
        state.recovery.repository.symbolCount +
        " symbols / " +
        state.recovery.repository.importCount +
        " imports"
      : "Repository map: not loaded",
    state.recovery
      ? "Recovered work: " +
        state.recovery.recommendation.title +
        " — " +
        state.recovery.recommendation.detail
      : undefined,
    state.kiloReloadRecommended ? "Kilo reload: recommended after config update" : undefined,
    state.lastError ? "Error: " + state.lastError : undefined,
  ].filter((line): line is string => Boolean(line));

  await vscode.window.showInformationMessage(lines.join("\n"), { modal: true });
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  await vscode.workspace.fs.createDirectory(context.globalStorageUri);

  const state: ExtensionState = {
    kiloConnected: false,
    kiloReloadRecommended: false,
    gatewayKeyConfigured: false,
  };

  let kiloPreviouslyInstalled = Boolean(vscode.extensions.getExtension(KILO_EXTENSION_ID));

  const output = vscode.window.createOutputChannel("LLMatic");
  context.subscriptions.push(output);

  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  context.subscriptions.push(statusBar);

  const statusProvider = new LlmaticStatusProvider();
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("llmatic.status", statusProvider),
    vscode.window.registerFileDecorationProvider(new LlmaticStatusDecorationProvider()),
  );

  const chatProvider = new AgentChatViewProvider();
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("llmatic.agentChat", chatProvider),
  );
  chatProvider.setHandlers({
    send: (text) => runAgentChatTurn(context, state, statusProvider, chatProvider, output, text),
    refresh: async () => {
      chatProvider.appendActivity("Refreshing repository map and workspace recovery…");
      await refreshWorkspaceRecovery(context, state, statusProvider, chatProvider, output, true);
      chatProvider.appendActivity("Repository context refreshed.", true);
    },
    continueRecommended: async () => {
      const recommendation = state.recovery?.recommendation;
      if (!recommendation) {
        await refreshWorkspaceRecovery(context, state, statusProvider, chatProvider, output, true);
      }

      const current = state.recovery?.recommendation;
      if (!current) {
        chatProvider.appendAssistant(
          "I could not resolve a recommended next action for this workspace.",
        );
        return;
      }

      if (current.action === "start_discovery") {
        await vscode.commands.executeCommand("llmatic.startDiscovery");
        return;
      }

      await runAgentChatTurn(
        context,
        state,
        statusProvider,
        chatProvider,
        output,
        "Continue with the recommended next action: " + current.title + ". " + current.detail,
      );
    },
  });

  context.subscriptions.push(
    vscode.commands.registerCommand("llmatic.startDiscovery", async () => {
      try {
        await startProjectDiscovery(context, state, output);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await vscode.window.showErrorMessage("LLMatic discovery: " + message);
      }
    }),
    vscode.commands.registerCommand("llmatic.discoveryStatus", async () => {
      try {
        await showProjectDiscovery(context, state, output);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await vscode.window.showErrorMessage("LLMatic discovery: " + message);
      }
    }),
    vscode.commands.registerCommand("llmatic.generatePlan", async () => {
      try {
        await generateProjectPlanInUi(context, state, output);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await vscode.window.showErrorMessage("LLMatic planning: " + message);
      }
    }),
    vscode.commands.registerCommand("llmatic.reviewPlan", async () => {
      try {
        await reviewProjectPlanInUi(context, state, output);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await vscode.window.showErrorMessage("LLMatic planning: " + message);
      }
    }),
    vscode.commands.registerCommand("llmatic.planReview", async () => {
      try {
        await projectPlanReviewInUi(context, state, output);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await vscode.window.showErrorMessage("LLMatic plan review: " + message);
      }
    }),
    vscode.commands.registerCommand("llmatic.editPlanDecisions", async () => {
      try {
        await editProjectDecisionsInUi(context, state, output);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await vscode.window.showErrorMessage("LLMatic edit decisions: " + message);
      }
    }),
    vscode.commands.registerCommand("llmatic.requestPlanChanges", async () => {
      try {
        await requestProjectPlanChangesInUi(context, state);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await vscode.window.showErrorMessage("LLMatic plan changes: " + message);
      }
    }),
    vscode.commands.registerCommand("llmatic.approveAndInitialize", async () => {
      try {
        await approveAndInitializeProjectInUi(context, state, output);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await vscode.window.showErrorMessage("LLMatic initialization: " + message);
      }
    }),
    vscode.commands.registerCommand("llmatic.getReady", async () => {
      try {
        await getReady(context, state, statusBar, statusProvider, output);
        await refreshJiraStatus(context, state, statusProvider);
        if (state.health?.status === "READY") {
          await refreshWorkspaceRecovery(
            context,
            state,
            statusProvider,
            chatProvider,
            output,
            true,
          );
        }
      } catch (error) {
        state.lastError = error instanceof Error ? error.message : String(error);
        state.health = {
          status: "NEEDS_REPAIR",
          issues: [
            {
              code: "runtime_error",
              kind: "repair",
              label: "LLMatic runtime error",
              detail: state.lastError,
            },
          ],
        };
        updateStatusBar(statusBar, state);
        statusProvider.update(state.health, state.gatewayKeyConfigured);
        await vscode.window.showErrorMessage("LLMatic Get Ready: " + state.lastError);
      }
    }),
    vscode.commands.registerCommand("llmatic.attachWorkspace", async () => {
      const folder = firstWorkspaceFolder();
      if (!folder) {
        await vscode.window.showWarningMessage("Open a workspace before attaching LLMatic.");
        return;
      }

      try {
        state.activeWorkspace = await attachWorkspace(context, folder);
        state.lastError = undefined;
        updateStatusBar(statusBar, state);
        await vscode.window.showInformationMessage(
          "LLMatic attached without adding runtime state to the repository.",
        );
      } catch (error) {
        state.lastError = error instanceof Error ? error.message : String(error);
        updateStatusBar(statusBar, state);
        await vscode.window.showErrorMessage(state.lastError);
      }
    }),
    vscode.commands.registerCommand("llmatic.bootstrapWorkspace", async () => {
      try {
        await bootstrapWorkspace(context, state, statusBar, output);
      } catch (error) {
        state.lastError = error instanceof Error ? error.message : String(error);
        updateStatusBar(statusBar, state);
        output.appendLine("");
        output.appendLine("[FAIL] Bootstrap: " + state.lastError);
        output.show(true);
        await vscode.window.showErrorMessage(state.lastError);
      }
    }),
    vscode.commands.registerCommand("llmatic.connectKilo", async () => {
      if (!vscode.extensions.getExtension(KILO_EXTENSION_ID)) {
        const action = await vscode.window.showWarningMessage(
          "Kilo Code is not installed.",
          "Open Extensions",
        );
        if (action === "Open Extensions") {
          await vscode.commands.executeCommand(
            "workbench.extensions.search",
            "@id:kilocode.kilo-code",
          );
        }
        return;
      }

      try {
        const result = await connectKilo(context);
        state.kiloConnected = result.connected;
        state.kiloReloadRecommended = result.changed;
        state.lastError = undefined;
        updateStatusBar(statusBar, state);

        if (result.changed) {
          const action = await vscode.window.showInformationMessage(
            "LLMatic MCP was added or updated in Kilo global config.",
            "Reload Window",
          );
          if (action === "Reload Window") {
            await vscode.commands.executeCommand("workbench.action.reloadWindow");
          }
        } else {
          await vscode.window.showInformationMessage(
            "LLMatic MCP is already registered and healthy in Kilo global config.",
          );
        }
      } catch (error) {
        state.lastError = error instanceof Error ? error.message : String(error);
        updateStatusBar(statusBar, state);
        await vscode.window.showErrorMessage(state.lastError);
      }
    }),
    vscode.commands.registerCommand("llmatic.showStatus", async () => {
      await showStatus(context, state);
    }),
    vscode.commands.registerCommand("llmatic.checkForUpdates", async () => {
      try {
        await checkForUpdates(context);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await vscode.window.showErrorMessage("LLMatic update check: " + message);
      }
    }),
    vscode.commands.registerCommand("llmatic.installUpdate", async () => {
      try {
        await installLatestUpdate(context);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await vscode.window.showErrorMessage("LLMatic update install: " + message);
      }
    }),
    vscode.commands.registerCommand("llmatic.doctor", async () => {
      await showDoctor(context, state, output);
    }),
    vscode.commands.registerCommand("llmatic.repairRuntime", async () => {
      try {
        await repairRuntime(context, state, statusBar, output);
      } catch (error) {
        state.lastError = error instanceof Error ? error.message : String(error);
        updateStatusBar(statusBar, state);
        await vscode.window.showErrorMessage("LLMatic runtime repair: " + state.lastError);
      }
    }),
    vscode.commands.registerCommand("llmatic.setKiloGatewayApiKey", async () => {
      await connectKiloGatewayInUi(context, state, statusProvider);
      statusProvider.setGatewayAccess(state.gatewayKeyConfigured, anonymousKiloAccessAvailable());
    }),
    vscode.commands.registerCommand("llmatic.connectKiloGateway", async () => {
      await connectKiloGatewayInUi(context, state, statusProvider);
      statusProvider.setGatewayAccess(state.gatewayKeyConfigured, anonymousKiloAccessAvailable());
    }),
    vscode.commands.registerCommand("llmatic.openConnectionCenter", async () => {
      await openConnectionCenter(context, state, statusProvider, chatProvider, output);
      statusProvider.setGatewayAccess(state.gatewayKeyConfigured, anonymousKiloAccessAvailable());
    }),
    vscode.commands.registerCommand("llmatic.clearKiloGatewayApiKey", async () => {
      await context.secrets.delete(KILO_GATEWAY_SECRET);
      state.gatewayKeyConfigured = false;
      statusProvider.update(state.health, state.gatewayKeyConfigured);
      statusProvider.setGatewayAccess(state.gatewayKeyConfigured, anonymousKiloAccessAvailable());

      await vscode.window.showInformationMessage(
        "Kilo Gateway API key cleared. Kilo MCP remains available; Auto Free can run anonymously when enabled.",
      );
    }),
    vscode.commands.registerCommand("llmatic.connectJiraWorkspace", async () => {
      try {
        await connectJiraWorkspace(context, state, statusProvider, chatProvider, output);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await refreshJiraStatus(context, state, statusProvider).catch(() => undefined);
        await vscode.window.showErrorMessage("LLMatic Jira connection: " + message);
      }
    }),
    vscode.commands.registerCommand("llmatic.disconnectJiraWorkspace", async () => {
      try {
        await disconnectJiraWorkspace(context, state, statusProvider, chatProvider, output);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await vscode.window.showErrorMessage("LLMatic Jira disconnect: " + message);
      }
    }),
    vscode.commands.registerCommand("llmatic.openAgentChat", async () => {
      await vscode.commands.executeCommand("workbench.view.extension.llmatic");
      await vscode.commands.executeCommand("llmatic.agentChat.focus");
    }),
    vscode.commands.registerCommand("llmatic.generatePrDraft", async () => {
      try {
        await generatePrDraftInUi(context, state, statusProvider, chatProvider, output);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await vscode.window.showErrorMessage("LLMatic PR draft: " + message);
      }
    }),
    vscode.commands.registerCommand("llmatic.showRepositoryRules", async () => {
      try {
        await showRepositoryRulesInUi(context, state, statusProvider, chatProvider, output);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await vscode.window.showErrorMessage("LLMatic rules: " + message);
      }
    }),
    vscode.commands.registerCommand("llmatic.reviewRuleProposals", async () => {
      try {
        await reviewRepositoryRuleProposalsInUi(
          context,
          state,
          statusProvider,
          chatProvider,
          output,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await vscode.window.showErrorMessage("LLMatic rule proposal review: " + message);
      }
    }),
    vscode.commands.registerCommand("llmatic.refreshWorkspaceRecovery", async () => {
      try {
        await refreshWorkspaceRecovery(context, state, statusProvider, chatProvider, output, true);
        await vscode.window.showInformationMessage(
          state.recovery
            ? "LLMatic repository context refreshed: " + state.recovery.recommendation.title
            : "LLMatic repository context cleared.",
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await vscode.window.showErrorMessage("LLMatic recovery: " + message);
      }
    }),
    vscode.commands.registerCommand("llmatic.runAgent", async () => {
      await vscode.commands.executeCommand("llmatic.openAgentChat");
    }),
    vscode.commands.registerCommand("llmatic.review", async () => {
      try {
        const review = await runGatewayReview(context, state, statusProvider, output, false);
        if (review) chatProvider.setReview(review);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await vscode.window.showErrorMessage("LLMatic review: " + message);
      }
    }),
    vscode.commands.registerCommand("llmatic.reviewFixLoop", async () => {
      try {
        const review = await runGatewayReview(context, state, statusProvider, output, true);
        if (review) chatProvider.setReview(review);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await vscode.window.showErrorMessage("LLMatic review/fix loop: " + message);
      }
    }),
    vscode.commands.registerCommand("llmatic.openWorkspaceData", async () => {
      if (!state.activeWorkspace) {
        await vscode.window.showWarningMessage("No LLMatic workspace is attached.");
        return;
      }

      await vscode.commands.executeCommand(
        "revealFileInOS",
        vscode.Uri.file(state.activeWorkspace.configPath),
      );
    }),
    vscode.extensions.onDidChange(async () => {
      const kiloInstalled = Boolean(vscode.extensions.getExtension(KILO_EXTENSION_ID));
      const justInstalled = !kiloPreviouslyInstalled && kiloInstalled;
      kiloPreviouslyInstalled = kiloInstalled;

      if (!justInstalled || !configuration().get<boolean>("autoConnectKilo", true)) return;

      output.appendLine("[SETUP] Kilo Code installation detected; resuming Get Ready.");
      await vscode.commands.executeCommand("llmatic.getReady");
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(async () => {
      await refresh(context, statusBar, state);
      statusProvider.update(state.health, state.gatewayKeyConfigured, state.recovery);
      await refreshJiraStatus(context, state, statusProvider);
      await refreshWorkspaceRecovery(
        context,
        state,
        statusProvider,
        chatProvider,
        output,
        false,
      ).catch((error) => {
        output.appendLine(
          "[WARN] Workspace recovery failed after folder change: " +
            (error instanceof Error ? error.message : String(error)),
        );
      });
    }),
    vscode.workspace.onDidChangeConfiguration(async (event) => {
      if (event.affectsConfiguration("llmatic")) {
        await refresh(context, statusBar, state);
        statusProvider.update(state.health, state.gatewayKeyConfigured, state.recovery);
        statusProvider.setGatewayAccess(state.gatewayKeyConfigured, anonymousKiloAccessAvailable());
        await refreshJiraStatus(context, state, statusProvider);
        await refreshWorkspaceRecovery(
          context,
          state,
          statusProvider,
          chatProvider,
          output,
          false,
        ).catch((error) => {
          output.appendLine(
            "[WARN] Workspace recovery failed after configuration change: " +
              (error instanceof Error ? error.message : String(error)),
          );
        });
      }
    }),
  );

  await refresh(context, statusBar, state);
  statusProvider.update(state.health, state.gatewayKeyConfigured, state.recovery);
  statusProvider.setGatewayAccess(state.gatewayKeyConfigured, anonymousKiloAccessAvailable());
  await refreshJiraStatus(context, state, statusProvider);
  await vscode.commands.executeCommand("setContext", "llmatic.health", state.health?.status);

  void refreshWorkspaceRecovery(context, state, statusProvider, chatProvider, output, false).catch(
    (error) => {
      output.appendLine(
        "[WARN] Initial workspace recovery failed: " +
          (error instanceof Error ? error.message : String(error)),
      );
    },
  );

  // Onboarding must never block extension activation. In headless Extension Host
  // acceptance there is no user available to answer the notification, and in
  // normal VS Code startup activation should complete independently of UI input.
  void offerOnboarding(context, state).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    output.appendLine("[WARN] LLMatic onboarding prompt failed: " + message);
  });
}

export function deactivate(): void {
  // No long-lived process is owned by the extension host.
}
