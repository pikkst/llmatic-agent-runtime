import { describe, expect, it } from "vitest";
import {
  externalConnectionProvider,
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
