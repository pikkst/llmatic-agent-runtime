import { describe, expect, it } from "vitest";
import {
  externalConnectionProvider,
  getBrokerHealth,
  pollBrokerConnection,
  startBrokerConnection,
} from "../src/index.js";

describe("external connection registry", () => {
  it("describes browser-first Jira and Kilo connection methods", () => {
    expect(externalConnectionProvider("jira")).toMatchObject({
      workspaceScoped: true,
      brokerProvider: "atlassian",
      methods: expect.arrayContaining(["browser_oauth", "manual_api_key"]),
    });
    expect(externalConnectionProvider("kilo_gateway")).toMatchObject({
      workspaceScoped: false,
      browserUrl: "https://app.kilo.ai",
      methods: expect.arrayContaining(["anonymous", "browser_api_key"]),
    });
  });

  it("reads broker readiness before browser authorization", async () => {
    const request: typeof fetch = async (input) => {
      expect(String(input)).toBe("https://broker.example/health");
      return new Response(
        JSON.stringify({
          ok: true,
          ready: false,
          service: "llmatic-oauth-broker",
          version: "1",
          providers: {
            atlassian: {
              ready: false,
              missing: ["ATLASSIAN_CLIENT_SECRET"],
            },
          },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    };

    await expect(getBrokerHealth("https://broker.example/", request)).resolves.toMatchObject({
      ready: false,
      providers: {
        atlassian: {
          ready: false,
          missing: ["ATLASSIAN_CLIENT_SECRET"],
        },
      },
    });
  });

  it("replaces HTML 404 broker pages with an actionable configuration error", async () => {
    const request: typeof fetch = async () =>
      new Response(
        "<!DOCTYPE html><html><head><title>JIRA</title></head><body>dead link</body></html>",
        {
          status: 404,
          statusText: "Not Found",
          headers: { "Content-Type": "text/html; charset=utf-8" },
        },
      );

    await expect(getBrokerHealth("https://jira.example", request)).rejects.toThrow(
      "does not appear to be an LLMatic OAuth broker",
    );
    await expect(getBrokerHealth("https://jira.example", request)).rejects.not.toThrow(
      "<!DOCTYPE html>",
    );
  });

  it("uses the generic broker protocol without leaking poll credentials into URLs", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const request: typeof fetch = async (input, init) => {
      requests.push({ url: String(input), init });
      const body =
        requests.length === 1
          ? {
              sessionId: "session-1",
              pollToken: "poll-secret",
              authorizeUrl: "https://auth.example/authorize",
              expiresAt: "2026-09-22T12:00:00.000Z",
            }
          : { status: "pending" };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const started = await startBrokerConnection(
      "https://broker.example",
      { provider: "atlassian" },
      request,
    );
    await pollBrokerConnection(
      "https://broker.example",
      started.sessionId,
      started.pollToken,
      request,
    );

    expect(requests[1]?.url).toContain("session=session-1");
    expect(requests[1]?.url).not.toContain("poll-secret");
    expect(new Headers(requests[1]?.init?.headers).get("Authorization")).toBe("Bearer poll-secret");
  });
});
