import { describe, expect, it } from "vitest";
import { KiloGatewayClient } from "../src/client.js";

describe("KiloGatewayClient", () => {
  it("uses chat completions and keeps the API key out of the request body", async () => {
    let requestedUrl = "";
    let requestedHeaders: HeadersInit | undefined;
    let requestedBody = "";

    const client = new KiloGatewayClient({
      apiKey: "secret-key",
      fetch: async (input, init) => {
        requestedUrl = String(input);
        requestedHeaders = init?.headers;
        requestedBody = String(init?.body ?? "");

        return new Response(
          JSON.stringify({
            id: "completion-1",
            model: "kilo-auto/free",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "done" },
                finish_reason: "stop",
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      },
    });

    await client.createChatCompletion({
      model: "kilo-auto/free",
      mode: "code",
      messages: [{ role: "user", content: "hello" }],
    });

    expect(requestedUrl).toBe("https://api.kilo.ai/api/gateway/chat/completions");
    expect(new Headers(requestedHeaders).get("Authorization")).toBe("Bearer secret-key");
    expect(new Headers(requestedHeaders).get("x-kilocode-mode")).toBe("code");
    expect(requestedBody).not.toContain("secret-key");
  });
  it("supports anonymous free-model requests without an Authorization header", async () => {
    let requestedHeaders: HeadersInit | undefined;

    const client = new KiloGatewayClient({
      fetch: async (_input, init) => {
        requestedHeaders = init?.headers;
        return new Response(
          JSON.stringify({
            id: "completion-anonymous",
            model: "kilo-auto/free",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "free" },
                finish_reason: "stop",
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      },
    });

    await client.createChatCompletion({
      model: "kilo-auto/free",
      messages: [{ role: "user", content: "hello" }],
    });

    expect(new Headers(requestedHeaders).has("Authorization")).toBe(false);
  });
  it("surfaces structured error details even when the gateway responds with HTTP 200", async () => {
    const client = new KiloGatewayClient({
      maxRetries: 0,
      fetch: async () =>
        new Response(
          JSON.stringify({
            error: {
              message: "No compatible free model is available for this request.",
              code: "upstream_model_unavailable",
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    });

    await expect(
      client.createChatCompletion({
        model: "kilo-auto/free",
        mode: "code",
        messages: [{ role: "user", content: "hello" }],
      }),
    ).rejects.toThrow(
      "Kilo Gateway returned an error payload: No compatible free model is available for this request.",
    );
  });

  it("reports a safe response shape when a successful payload has no assistant message", async () => {
    const client = new KiloGatewayClient({
      maxRetries: 0,
      fetch: async () =>
        new Response(
          JSON.stringify({
            id: "completion-empty",
            object: "chat.completion",
            model: "kilo-auto/free",
            choices: [],
            provider: "example",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    });

    await expect(
      client.createChatCompletion({
        model: "kilo-auto/free",
        mode: "code",
        messages: [{ role: "user", content: "hello" }],
      }),
    ).rejects.toThrow(
      "Kilo Gateway returned a 2xx response without choices[0].message (model=kilo-auto/free; object=chat.completion; choices=0; keys=id,object,model,choices,provider).",
    );
  });
  it("retries a transient HTTP-200 upstream overload and returns the recovered completion", async () => {
    let calls = 0;
    const retries: Array<{ nextAttempt: number; maxAttempts: number; reason: string }> = [];

    const client = new KiloGatewayClient({
      retryBaseDelayMs: 1,
      sleep: async () => {},
      onRetry: (event) => {
        retries.push({
          nextAttempt: event.nextAttempt,
          maxAttempts: event.maxAttempts,
          reason: event.reason,
        });
      },
      fetch: async () => {
        calls += 1;
        if (calls === 1) {
          return new Response(
            JSON.stringify({
              error: {
                message: "Upstream error from Nvidia: Service temporarily overloaded",
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }

        return new Response(
          JSON.stringify({
            id: "completion-recovered",
            model: "kilo-auto/free",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "Recovered." },
                finish_reason: "stop",
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      },
    });

    const response = await client.createChatCompletion({
      model: "kilo-auto/free",
      mode: "code",
      messages: [{ role: "user", content: "hello" }],
    });

    expect(calls).toBe(2);
    expect(response.choices[0]?.message.content).toBe("Recovered.");
    expect(retries).toHaveLength(1);
    expect(retries[0]).toMatchObject({
      nextAttempt: 2,
      maxAttempts: 3,
    });
    expect(retries[0]?.reason).toContain("temporarily overloaded");
  });

  it("retries HTTP 429 and 5xx failures but does not retry authentication failures", async () => {
    let retryableCalls = 0;
    const retryable = new KiloGatewayClient({
      retryBaseDelayMs: 1,
      sleep: async () => {},
      fetch: async () => {
        retryableCalls += 1;
        if (retryableCalls === 1) {
          return new Response(JSON.stringify({ error: { message: "Too many requests" } }), {
            status: 429,
            statusText: "Too Many Requests",
          });
        }

        return new Response(
          JSON.stringify({
            id: "completion-after-429",
            model: "kilo-auto/free",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "ok" },
                finish_reason: "stop",
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      },
    });

    await expect(
      retryable.createChatCompletion({
        model: "kilo-auto/free",
        messages: [{ role: "user", content: "hello" }],
      }),
    ).resolves.toMatchObject({ id: "completion-after-429" });
    expect(retryableCalls).toBe(2);

    let authCalls = 0;
    const authFailure = new KiloGatewayClient({
      sleep: async () => {},
      fetch: async () => {
        authCalls += 1;
        return new Response(JSON.stringify({ error: { message: "Invalid API key" } }), {
          status: 401,
          statusText: "Unauthorized",
        });
      },
    });

    await expect(
      authFailure.createChatCompletion({
        model: "kilo-auto/free",
        messages: [{ role: "user", content: "hello" }],
      }),
    ).rejects.toThrow("401 Unauthorized");
    expect(authCalls).toBe(1);
  });
});
