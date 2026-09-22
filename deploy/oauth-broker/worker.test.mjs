import { describe, expect, it } from "vitest";
import worker from "./worker.mjs";

function completeEnv() {
  return {
    ATLASSIAN_CLIENT_ID: "client-id",
    ATLASSIAN_CLIENT_SECRET: "client-secret",
    ATLASSIAN_REDIRECT_URI:
      "https://oauth.example/v1/connections/callback/atlassian",
    CONNECTION_SESSIONS: {
      async get() {
        return null;
      },
      async put() {},
      async delete() {},
    },
  };
}

describe("LLMatic OAuth broker", () => {
  it("reports missing provider configuration without exposing secrets", async () => {
    const response = await worker.fetch(
      new Request("https://oauth.example/health"),
      {},
    );
    const body = await response.json();

    expect(response.status).toBe(200);
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
    const response = await worker.fetch(
      new Request("https://oauth.example/health"),
      completeEnv(),
    );

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
});
