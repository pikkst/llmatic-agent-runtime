const ATLASSIAN_AUTHORIZE_URL = "https://auth.atlassian.com/authorize";
const ATLASSIAN_TOKEN_URL = "https://auth.atlassian.com/oauth/token";
const ATLASSIAN_RESOURCES_URL =
  "https://api.atlassian.com/oauth/token/accessible-resources";
const SESSION_TTL_SECONDS = 600;
const ATLASSIAN_SCOPES =
  "read:jira-user read:jira-work write:jira-work offline_access";

function json(body, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set("Content-Type", "application/json");
  headers.set("Cache-Control", "no-store");
  return new Response(JSON.stringify(body), { ...init, headers });
}

function html(body, status = 200) {
  return new Response(
    "<!doctype html><html><head><meta charset=\"utf-8\"><title>LLMatic connection</title></head>" +
      "<body style=\"font-family:system-ui;padding:32px;max-width:720px;margin:auto\">" +
      body +
      "</body></html>",
    {
      status,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      },
    },
  );
}

function requiredEnv(env, name) {
  const value = String(env[name] || "").trim();
  if (!value) throw new Error("Missing broker configuration " + name + ".");
  return value;
}

function randomToken(bytes = 32) {
  const data = new Uint8Array(bytes);
  crypto.getRandomValues(data);
  return btoa(String.fromCharCode(...data))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

async function sha256(value) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    throw new Error("Request body must be valid JSON.");
  }
}

async function atlassianToken(env, payload) {
  const response = await fetch(ATLASSIAN_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_id: requiredEnv(env, "ATLASSIAN_CLIENT_ID"),
      client_secret: requiredEnv(env, "ATLASSIAN_CLIENT_SECRET"),
      ...payload,
    }),
  });

  const raw = await response.text();
  if (!response.ok) {
    throw new Error(
      "Atlassian token exchange failed with " +
        response.status +
        (raw.trim() ? ": " + raw.trim().slice(0, 500) : ""),
    );
  }
  return JSON.parse(raw);
}

async function startConnection(request, env) {
  const body = await readJson(request);
  if (body.provider !== "atlassian") {
    return json({ error: "Unsupported connection provider." }, { status: 400 });
  }

  const sessions = env.CONNECTION_SESSIONS;
  if (!sessions) {
    return json(
      { error: "CONNECTION_SESSIONS KV binding is not configured." },
      { status: 503 },
    );
  }

  const sessionId = crypto.randomUUID();
  const pollToken = randomToken();
  const state = randomToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000).toISOString();

  const session = {
    provider: "atlassian",
    status: "pending",
    pollTokenHash: await sha256(pollToken),
    state,
    expiresAt,
    returnLabel:
      typeof body.returnLabel === "string" ? body.returnLabel.slice(0, 160) : undefined,
  };

  await Promise.all([
    sessions.put("session:" + sessionId, JSON.stringify(session), {
      expirationTtl: SESSION_TTL_SECONDS,
    }),
    sessions.put("state:" + state, sessionId, {
      expirationTtl: SESSION_TTL_SECONDS,
    }),
  ]);

  const authorize = new URL(ATLASSIAN_AUTHORIZE_URL);
  authorize.searchParams.set("audience", "api.atlassian.com");
  authorize.searchParams.set("client_id", requiredEnv(env, "ATLASSIAN_CLIENT_ID"));
  authorize.searchParams.set("scope", ATLASSIAN_SCOPES);
  authorize.searchParams.set("redirect_uri", requiredEnv(env, "ATLASSIAN_REDIRECT_URI"));
  authorize.searchParams.set("state", state);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("prompt", "consent");

  return json({
    sessionId,
    pollToken,
    authorizeUrl: authorize.toString(),
    expiresAt,
  });
}

async function atlassianCallback(request, env) {
  const url = new URL(request.url);
  const state = url.searchParams.get("state") || "";
  const code = url.searchParams.get("code") || "";
  const error = url.searchParams.get("error");
  const sessions = env.CONNECTION_SESSIONS;

  if (!sessions || !state) {
    return html("<h1>LLMatic connection failed</h1><p>Missing connection state.</p>", 400);
  }

  const sessionId = await sessions.get("state:" + state);
  const raw = sessionId ? await sessions.get("session:" + sessionId) : null;
  if (!sessionId || !raw) {
    return html(
      "<h1>LLMatic connection expired</h1><p>Return to VS Code and start the connection again.</p>",
      400,
    );
  }

  const session = JSON.parse(raw);
  if (session.state !== state) {
    return html("<h1>LLMatic connection failed</h1><p>Invalid OAuth state.</p>", 400);
  }

  if (error || !code) {
    session.status = "error";
    session.message = error || "Atlassian did not return an authorization code.";
    await sessions.put("session:" + sessionId, JSON.stringify(session), {
      expirationTtl: SESSION_TTL_SECONDS,
    });
    return html(
      "<h1>Connection not completed</h1><p>You can close this tab and return to VS Code.</p>",
      400,
    );
  }

  try {
    const token = await atlassianToken(env, {
      grant_type: "authorization_code",
      code,
      redirect_uri: requiredEnv(env, "ATLASSIAN_REDIRECT_URI"),
    });

    const resourcesResponse = await fetch(ATLASSIAN_RESOURCES_URL, {
      headers: {
        Accept: "application/json",
        Authorization: "Bearer " + token.access_token,
      },
    });
    if (!resourcesResponse.ok) {
      throw new Error(
        "Atlassian accessible-resources lookup failed with " +
          resourcesResponse.status +
          ".",
      );
    }

    const resources = await resourcesResponse.json();
    session.status = "connected";
    session.resources = Array.isArray(resources)
      ? resources.map((resource) => ({
          id: String(resource.id || ""),
          name: String(resource.name || resource.url || "Atlassian site"),
          url: String(resource.url || ""),
          scopes: Array.isArray(resource.scopes) ? resource.scopes : [],
        }))
      : [];
    session.credential = {
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      expiresAt:
        typeof token.expires_in === "number"
          ? new Date(Date.now() + token.expires_in * 1000).toISOString()
          : undefined,
      tokenType: token.token_type,
      scope: token.scope,
    };

    await sessions.put("session:" + sessionId, JSON.stringify(session), {
      expirationTtl: SESSION_TTL_SECONDS,
    });
    await sessions.delete("state:" + state);

    return html(
      "<h1>LLMatic is connected to Atlassian</h1>" +
        "<p>Authorization succeeded. Return to VS Code to choose the Jira site and project.</p>" +
        "<p>You can close this tab.</p>",
    );
  } catch (cause) {
    session.status = "error";
    session.message = cause instanceof Error ? cause.message : String(cause);
    await sessions.put("session:" + sessionId, JSON.stringify(session), {
      expirationTtl: SESSION_TTL_SECONDS,
    });
    return html(
      "<h1>LLMatic connection failed</h1><p>Return to VS Code for details.</p>",
      500,
    );
  }
}

async function connectionStatus(request, env) {
  const sessions = env.CONNECTION_SESSIONS;
  if (!sessions) return json({ error: "Connection storage unavailable." }, { status: 503 });

  const url = new URL(request.url);
  const sessionId = url.searchParams.get("session") || "";
  const authorization = request.headers.get("Authorization") || "";
  const pollToken = authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : "";

  if (!sessionId || !pollToken) {
    return json({ error: "Missing connection session credentials." }, { status: 401 });
  }

  const raw = await sessions.get("session:" + sessionId);
  if (!raw) {
    return json({ error: "Connection session expired." }, { status: 410 });
  }

  const session = JSON.parse(raw);
  if ((await sha256(pollToken)) !== session.pollTokenHash) {
    return json({ error: "Invalid connection poll credential." }, { status: 403 });
  }

  if (session.status === "pending") return json({ status: "pending" });
  if (session.status === "error") {
    await sessions.delete("session:" + sessionId);
    return json({ status: "error", message: session.message || "Connection failed." });
  }

  const response = {
    status: "connected",
    provider: session.provider,
    resources: session.resources || [],
    credential: session.credential,
  };
  await sessions.delete("session:" + sessionId);
  return json(response);
}

async function refreshConnection(request, env) {
  const body = await readJson(request);
  if (body.provider !== "atlassian" || typeof body.refreshToken !== "string") {
    return json({ error: "Unsupported refresh request." }, { status: 400 });
  }

  try {
    const token = await atlassianToken(env, {
      grant_type: "refresh_token",
      refresh_token: body.refreshToken,
    });
    return json({
      credential: {
        accessToken: token.access_token,
        refreshToken: token.refresh_token || body.refreshToken,
        expiresAt:
          typeof token.expires_in === "number"
            ? new Date(Date.now() + token.expires_in * 1000).toISOString()
            : undefined,
        tokenType: token.token_type,
        scope: token.scope,
      },
    });
  } catch (cause) {
    return json(
      { error: cause instanceof Error ? cause.message : String(cause) },
      { status: 502 },
    );
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true });
    }
    if (request.method === "POST" && url.pathname === "/v1/connections/start") {
      return startConnection(request, env);
    }
    if (
      request.method === "GET" &&
      url.pathname === "/v1/connections/callback/atlassian"
    ) {
      return atlassianCallback(request, env);
    }
    if (request.method === "GET" && url.pathname === "/v1/connections/status") {
      return connectionStatus(request, env);
    }
    if (request.method === "POST" && url.pathname === "/v1/connections/refresh") {
      return refreshConnection(request, env);
    }

    return json({ error: "Not found." }, { status: 404 });
  },
};
