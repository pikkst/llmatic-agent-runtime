export type ExternalConnectionId = "jira" | "kilo_gateway";

export type ExternalConnectionMethod =
  "browser_oauth" | "browser_api_key" | "manual_api_key" | "manual_bearer" | "anonymous";

export interface ExternalConnectionProvider {
  id: ExternalConnectionId;
  label: string;
  description: string;
  workspaceScoped: boolean;
  methods: readonly ExternalConnectionMethod[];
  browserUrl?: string;
  documentationUrl?: string;
  brokerProvider?: string;
}

export interface BrokerConnectionStart {
  sessionId: string;
  pollToken: string;
  authorizeUrl: string;
  expiresAt: string;
}

export interface BrokerResource {
  id: string;
  name: string;
  url: string;
  scopes?: string[];
}

export interface BrokerCredential {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
  tokenType?: string;
  scope?: string;
}

export type BrokerConnectionStatus =
  | { status: "pending" }
  | {
      status: "connected";
      provider: string;
      resources: BrokerResource[];
      credential: BrokerCredential;
    }
  | { status: "error"; message: string };

export interface BrokerRefreshResult {
  credential: BrokerCredential;
}

export interface BrokerHealth {
  ok: boolean;
  ready: boolean;
  service: string;
  version: string;
  providers: Record<
    string,
    {
      ready: boolean;
      missing: string[];
    }
  >;
}

export const EXTERNAL_CONNECTION_PROVIDERS: readonly ExternalConnectionProvider[] = [
  {
    id: "jira",
    label: "Jira",
    description: "Workspace task source and workflow synchronization.",
    workspaceScoped: true,
    methods: ["browser_oauth", "manual_api_key", "manual_bearer"],
    documentationUrl: "https://developer.atlassian.com/cloud/jira/platform/oauth-2-3lo-apps/",
    brokerProvider: "atlassian",
  },
  {
    id: "kilo_gateway",
    label: "Kilo Gateway",
    description: "Direct LLMatic agent and review model access.",
    workspaceScoped: false,
    methods: ["anonymous", "browser_api_key", "manual_api_key"],
    browserUrl: "https://app.kilo.ai",
    documentationUrl: "https://kilo.ai/docs/getting-started/setup-authentication",
  },
] as const;

export function externalConnectionProvider(id: ExternalConnectionId): ExternalConnectionProvider {
  const provider = EXTERNAL_CONNECTION_PROVIDERS.find((candidate) => candidate.id === id);
  if (!provider) throw new Error("Unknown external connection provider: " + id);
  return provider;
}

function brokerEndpoint(baseUrl: string, path: string): string {
  const base = baseUrl.trim().replace(/\/+$/, "");
  if (!base) throw new Error("External connection broker URL is not configured.");
  return base + path;
}

async function brokerJson<T>(response: Response, operation: string): Promise<T> {
  const raw = await response.text();
  if (!response.ok) {
    let detail = raw.trim();
    try {
      const parsed = JSON.parse(raw) as { error?: string; message?: string };
      detail = parsed.error ?? parsed.message ?? detail;
    } catch {
      // Preserve non-JSON broker diagnostics.
    }
    throw new Error(
      operation +
        " failed with " +
        response.status +
        " " +
        response.statusText +
        (detail ? ": " + detail.slice(0, 500) : ""),
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    throw new Error(
      operation +
        " returned invalid JSON: " +
        (error instanceof Error ? error.message : String(error)),
    );
  }
}

export async function getBrokerHealth(
  baseUrl: string,
  request: typeof fetch = fetch,
): Promise<BrokerHealth> {
  const response = await request(brokerEndpoint(baseUrl, "/health"), {
    headers: { Accept: "application/json" },
  });

  return brokerJson<BrokerHealth>(response, "Connection broker health");
}

export async function startBrokerConnection(
  baseUrl: string,
  input: {
    provider: string;
    returnLabel?: string;
  },
  request: typeof fetch = fetch,
): Promise<BrokerConnectionStart> {
  const response = await request(brokerEndpoint(baseUrl, "/v1/connections/start"), {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(input),
  });

  return brokerJson<BrokerConnectionStart>(response, "Connection broker start");
}

export async function pollBrokerConnection(
  baseUrl: string,
  sessionId: string,
  pollToken: string,
  request: typeof fetch = fetch,
): Promise<BrokerConnectionStatus> {
  const url = new URL(brokerEndpoint(baseUrl, "/v1/connections/status"));
  url.searchParams.set("session", sessionId);

  const response = await request(url, {
    headers: {
      Accept: "application/json",
      Authorization: "Bearer " + pollToken,
    },
  });

  return brokerJson<BrokerConnectionStatus>(response, "Connection broker status");
}

export async function refreshBrokerCredential(
  baseUrl: string,
  provider: string,
  refreshToken: string,
  request: typeof fetch = fetch,
): Promise<BrokerRefreshResult> {
  const response = await request(brokerEndpoint(baseUrl, "/v1/connections/refresh"), {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ provider, refreshToken }),
  });

  return brokerJson<BrokerRefreshResult>(response, "Connection broker refresh");
}
