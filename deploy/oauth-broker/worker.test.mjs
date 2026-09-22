import { describe, expect, it } from "vitest";
import worker from "./worker.mjs";

function memoryKv() {
  const values = new Map();
  return {
    values,
    async get(key) {
      return values.get(key) ?? null;
    },
    async put(key, value) {
      values.set(key, value);
    },
    async delete(key) {
      values.delete(key);
    },
  };
}

function completeEnv() {
  return {
    ATLASSIAN_CLIENT_ID: "client-id",
    ATLASSIAN_CLIENT_SECRET: "client-secret",
    ATLASSIAN_REDIRECT_URI: "https://oauth.example/v1/connections/callback/atlassian",
    CONNECTION_SESSIONS: memoryKv(),
  };
}

describe("LLMatic OAuth broker", () => {
  it("reports missing provider configuration without exposing secrets", async () => {
    const response = await worker.fetch(new Request("https://oauth.example/health"), {});
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(body).toMatchObject({
      ok: true,
      ready: false,
      service: "llmatic-oauth-broker",
      version: "1",
      providers: {
        atlassian: {
          ready: false,
          missing: expect.arrayContaining([
            "ATLASSIAN_CLIENT_ID",
            "ATLASSIAN_CLIENT_SECRET",
            "ATLASSIAN_REDIRECT_URI",
            "CONNECTION_SESSIONS",
          ]),
        },
      },
    });
    expect(JSON.stringify(body)).not.toContain("client-secret");
  });

  it("reports ready when Atlassian and session storage are configured", async () => {
    const response = await worker.fetch(new Request("https://oauth.example/health"), completeEnv());

    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      ready: true,
      providers: {
        atlassian: {
          ready: true,
          missing: [],
        },
      },
    });
  });

  it("refuses OAuth session creation before the provider is configured", async () => {
    const response = await worker.fetch(
      new Request("https://oauth.example/v1/connections/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "atlassian" }),
      }),
      {},
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: "Atlassian OAuth provider is not configured.",
    });
  });

  it("stores only a hash of the poll credential and rejects the wrong credential", async () => {
    const env = completeEnv();
    const startResponse = await worker.fetch(
      new Request("https://oauth.example/v1/connections/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "atlassian", returnLabel: "Krunditark" }),
      }),
      env,
    );
    const started = await startResponse.json();

    expect(startResponse.status).toBe(200);
    expect(started.authorizeUrl).toContain("https://auth.atlassian.com/authorize");
    expect(started.authorizeUrl).toContain("client_id=client-id");
    expect(started.pollToken).toBeTruthy();

    const stored = Array.from(env.CONNECTION_SESSIONS.values.entries()).find(([key]) =>
      key.startsWith("session:"),
    );
    expect(stored).toBeTruthy();
    expect(stored[1]).not.toContain(started.pollToken);
    expect(JSON.parse(stored[1]).pollTokenHash).toMatch(/^[a-f0-9]{64}$/);

    const denied = await worker.fetch(
      new Request(
        "https://oauth.example/v1/connections/status?session=" +
          encodeURIComponent(started.sessionId),
        {
          headers: { Authorization: "Bearer wrong-token" },
        },
      ),
      env,
    );
    expect(denied.status).toBe(403);
  });

  it("protects OAuth callback pages against framing and external content", async () => {
    const response = await worker.fetch(
      new Request("https://oauth.example/v1/connections/callback/atlassian?state=missing"),
      completeEnv(),
    );

    expect(response.status).toBe(400);
    expect(response.headers.get("X-Frame-Options")).toBe("DENY");
    expect(response.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
  });
});
