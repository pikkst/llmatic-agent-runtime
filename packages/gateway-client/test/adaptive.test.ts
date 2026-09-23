import { describe, expect, it } from "vitest";
import { AdaptiveFreeGatewayClient } from "../src/adaptive.js";

function completion(model: string, content = '{"summary":"ok","findings":[]}') {
  return new Response(
    JSON.stringify({
      id: "completion-" + model,
      model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content },
          finish_reason: "stop",
        },
      ],
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

describe("AdaptiveFreeGatewayClient", () => {
  it("discovers live free models and fails over across providers before Auto Free", async () => {
    const requestedModels: string[] = [];
    const events: Array<{ type: string; candidateModel?: string }> = [];

    const client = new AdaptiveFreeGatewayClient({
      maxRetries: 0,
      maxModelAttempts: 4,
      requestTimeoutMs: 5_000,
      onRoute: (event) => events.push(event),
      fetch: async (input, init) => {
        const url = String(input);
        if (url.endsWith("/models")) {
          return new Response(
            JSON.stringify({
              data: [
                {
                  id: "nvidia/mini-flash:free",
                  owned_by: "nvidia",
                  context_length: 262144,
                  pricing: { prompt: "0", completion: "0" },
                },
                {
                  id: "z-ai/medium:free",
                  owned_by: "z-ai",
                  context_length: 131072,
                  pricing: { prompt: "0", completion: "0" },
                },
                {
                  id: "paid/model",
                  owned_by: "paid",
                  context_length: 1000000,
                  pricing: { prompt: "0.001", completion: "0.002" },
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }

        const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
        requestedModels.push(String(body.model));
        if (body.model === "nvidia/mini-flash:free") {
          return new Response(
            JSON.stringify({
              error: { message: "Upstream error from Nvidia: Service temporarily overloaded" },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }

        return completion(String(body.model));
      },
    });

    const response = await client.createChatCompletion({
      model: "kilo-auto/free",
      messages: [{ role: "user", content: "review" }],
      routing: { task: "review_bug_hunter" },
      response_format: { type: "json_object" },
      tool_choice: "none",
    });

    expect(response.model).toBe("z-ai/medium:free");
    expect(requestedModels).toEqual(["nvidia/mini-flash:free", "z-ai/medium:free"]);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "catalog" }),
        expect.objectContaining({
          type: "failure",
          candidateModel: "nvidia/mini-flash:free",
        }),
        expect.objectContaining({
          type: "success",
          candidateModel: "z-ai/medium:free",
        }),
      ]),
    );

    requestedModels.length = 0;
    await client.createChatCompletion({
      model: "kilo-auto/free",
      messages: [{ role: "user", content: "security review" }],
      routing: { task: "review_security" },
    });
    expect(requestedModels[0]).toBe("z-ai/medium:free");
  });

  it("honors per-request avoided models after an invalid structured response", async () => {
    const requestedModels: string[] = [];

    const client = new AdaptiveFreeGatewayClient({
      maxRetries: 0,
      maxModelAttempts: 3,
      fetch: async (input, init) => {
        if (String(input).endsWith("/models")) {
          return new Response(
            JSON.stringify({
              data: [
                {
                  id: "provider/a:free",
                  owned_by: "provider-a",
                  context_length: 200000,
                },
                {
                  id: "provider/b:free",
                  owned_by: "provider-b",
                  context_length: 100000,
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }

        const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
        requestedModels.push(String(body.model));
        return completion(String(body.model));
      },
    });

    const response = await client.createChatCompletion({
      model: "kilo-auto/free",
      messages: [{ role: "user", content: "repair" }],
      routing: {
        task: "review_general",
        avoidModels: ["provider/a:free"],
      },
    });

    expect(response.model).toBe("provider/b:free");
    expect(requestedModels[0]).toBe("provider/b:free");
  });

  it("cools down a semantically invalid model for subsequent review requests", async () => {
    const requestedModels: string[] = [];

    const client = new AdaptiveFreeGatewayClient({
      maxRetries: 0,
      maxModelAttempts: 3,
      modelCooldownMs: 60_000,
      fetch: async (input, init) => {
        if (String(input).endsWith("/models")) {
          return new Response(
            JSON.stringify({
              data: [
                {
                  id: "dots/model:free",
                  owned_by: "dots",
                  context_length: 200000,
                },
                {
                  id: "other/model:free",
                  owned_by: "other",
                  context_length: 100000,
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }

        const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
        requestedModels.push(String(body.model));
        return completion(String(body.model));
      },
    });

    await client.reportModelFailure({
      model: "dots/model:free",
      task: "review_general",
      reason: "empty structured review content",
    });

    await client.createChatCompletion({
      model: "kilo-auto/free",
      messages: [{ role: "user", content: "review" }],
      routing: { task: "review_general" },
    });

    expect(requestedModels[0]).toBe("other/model:free");
  });

  it("uses a 24-hour cooldown for provider daily-limit failures", async () => {
    const requestedModels: string[] = [];

    const client = new AdaptiveFreeGatewayClient({
      maxRetries: 0,
      maxModelAttempts: 3,
      fetch: async (input, init) => {
        if (String(input).endsWith("/models")) {
          return new Response(
            JSON.stringify({
              data: [
                {
                  id: "daily/model:free",
                  owned_by: "daily",
                  context_length: 200000,
                },
                {
                  id: "fallback/model:free",
                  owned_by: "fallback",
                  context_length: 100000,
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }

        const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
        requestedModels.push(String(body.model));
        if (body.model === "daily/model:free") {
          return new Response(
            JSON.stringify({
              error: {
                message:
                  "Rate limit exceeded: limit_rpd/daily-model. Daily limit reached for daily/model:free.",
              },
            }),
            {
              status: 429,
              statusText: "Too Many Requests",
              headers: { "Content-Type": "application/json" },
            },
          );
        }
        return completion(String(body.model));
      },
    });

    await client.createChatCompletion({
      model: "kilo-auto/free",
      messages: [{ role: "user", content: "first" }],
      routing: { task: "review_general" },
    });

    requestedModels.length = 0;
    await client.createChatCompletion({
      model: "kilo-auto/free",
      messages: [{ role: "user", content: "second" }],
      routing: { task: "review_general" },
    });

    expect(requestedModels).not.toContain("daily/model:free");
  });

  it("preserves routed free-model identity when provider response drops the :free suffix", async () => {
    const client = new AdaptiveFreeGatewayClient({
      maxRetries: 0,
      maxModelAttempts: 2,
      fetch: async (input, init) => {
        if (String(input).endsWith("/models")) {
          return new Response(
            JSON.stringify({
              data: [
                {
                  id: "stepfun/step-3.7-flash:free",
                  owned_by: "stepfun",
                  context_length: 131072,
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
        return completion(String(body.model).replace(/:free$/, ""));
      },
    });

    const response = await client.createChatCompletion({
      model: "kilo-auto/free",
      messages: [{ role: "user", content: "review" }],
      routing: { task: "review_bug_hunter" },
    });

    expect(response.model).toBe("stepfun/step-3.7-flash");
    expect(response.routed_model).toBe("stepfun/step-3.7-flash:free");
  });

  it("falls through provider-level 400 errors and blocks that provider for the session", async () => {
    const requestedModels: string[] = [];

    const client = new AdaptiveFreeGatewayClient({
      maxRetries: 0,
      maxModelAttempts: 3,
      fetch: async (input, init) => {
        if (String(input).endsWith("/models")) {
          return new Response(
            JSON.stringify({
              data: [
                {
                  id: "inclusionai/flash-fast:free",
                  owned_by: "inclusionai",
                  context_length: 131072,
                },
                {
                  id: "other/mini:free",
                  owned_by: "other",
                  context_length: 131072,
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }

        const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
        requestedModels.push(String(body.model));
        if (String(body.model).startsWith("inclusionai/")) {
          return new Response(JSON.stringify({ error: { message: "Provider returned error" } }), {
            status: 400,
            statusText: "Bad Request",
            headers: { "Content-Type": "application/json" },
          });
        }
        return completion(String(body.model));
      },
    });

    await expect(
      client.createChatCompletion({
        model: "kilo-auto/free",
        messages: [{ role: "user", content: "review" }],
        routing: { task: "review_general" },
      }),
    ).resolves.toMatchObject({ routed_model: "other/mini:free" });

    expect(requestedModels).toEqual(["inclusionai/flash-fast:free", "other/mini:free"]);

    requestedModels.length = 0;
    await client.createChatCompletion({
      model: "kilo-auto/free",
      messages: [{ role: "user", content: "review again" }],
      routing: { task: "review_security" },
    });
    expect(requestedModels[0]).toBe("other/mini:free");
  });

  it("prefers bounded-review speed signals over oversized context windows", async () => {
    const requestedModels: string[] = [];

    const client = new AdaptiveFreeGatewayClient({
      maxRetries: 0,
      maxModelAttempts: 2,
      fetch: async (input, init) => {
        if (String(input).endsWith("/models")) {
          return new Response(
            JSON.stringify({
              data: [
                {
                  id: "nvidia/nemotron-ultra-550b:free",
                  owned_by: "nvidia",
                  context_length: 1000000,
                },
                {
                  id: "fast/mini-flash:free",
                  owned_by: "fast",
                  context_length: 131072,
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
        requestedModels.push(String(body.model));
        return completion(String(body.model));
      },
    });

    await client.createChatCompletion({
      model: "kilo-auto/free",
      messages: [{ role: "user", content: "review" }],
      routing: { task: "review_general" },
    });

    expect(requestedModels[0]).toBe("fast/mini-flash:free");
  });

  it("falls back to configured Auto Free when live catalog discovery fails", async () => {
    const requestedModels: string[] = [];

    const client = new AdaptiveFreeGatewayClient({
      maxRetries: 0,
      fetch: async (input, init) => {
        if (String(input).endsWith("/models")) {
          return new Response("unavailable", { status: 503, statusText: "Unavailable" });
        }

        const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
        requestedModels.push(String(body.model));
        return completion(String(body.model));
      },
    });

    await expect(
      client.createChatCompletion({
        model: "kilo-auto/free",
        messages: [{ role: "user", content: "review" }],
        routing: { task: "review_security" },
      }),
    ).resolves.toMatchObject({ model: "kilo-auto/free" });

    expect(requestedModels).toEqual(["kilo-auto/free"]);
  });

  it(
    "uses prompt-only JSON when advertised model capabilities omit structured output",
    async () => {
    const requestBodies: Array<Record<string, unknown>> = [];

    const client = new AdaptiveFreeGatewayClient({
      maxRetries: 0,
      maxModelAttempts: 1,
      fetch: async (input, init) => {
        if (String(input).endsWith("/models")) {
          return new Response(
            JSON.stringify({
              data: [
                {
                  id: "provider/plain-fast:free",
                  owned_by: "provider",
                  context_length: 131072,
                  supported_parameters: ["max_tokens", "temperature"],
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }

        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        requestBodies.push(body);
        return completion(String(body.model));
      },
    });

    await client.createChatCompletion({
      model: "kilo-auto/free",
      messages: [{ role: "user", content: "Return JSON." }],
      routing: { task: "review_general" },
      response_format: { type: "json_object" },
    });

    expect(requestBodies).toHaveLength(1);
    expect(requestBodies[0]).not.toHaveProperty("response_format");
    },
  );

  it(
    "preserves native structured output when the live catalog advertises response_format",
    async () => {
    const requestBodies: Array<Record<string, unknown>> = [];

    const client = new AdaptiveFreeGatewayClient({
      maxRetries: 0,
      maxModelAttempts: 1,
      fetch: async (input, init) => {
        if (String(input).endsWith("/models")) {
          return new Response(
            JSON.stringify({
              data: [
                {
                  id: "provider/json-fast:free",
                  owned_by: "provider",
                  context_length: 131072,
                  supported_parameters: ["max_tokens", "temperature", "response_format"],
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }

        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        requestBodies.push(body);
        return completion(String(body.model));
      },
    });

    await client.createChatCompletion({
      model: "kilo-auto/free",
      messages: [{ role: "user", content: "Return JSON." }],
      routing: { task: "review_general" },
      response_format: { type: "json_object" },
    });

    expect(requestBodies[0]?.response_format).toEqual({ type: "json_object" });
    },
  );

  it("opens an Auto Free session circuit breaker after two transient failures", async () => {
    let chatRequests = 0;

    const client = new AdaptiveFreeGatewayClient({
      maxRetries: 0,
      maxModelAttempts: 1,
      fetch: async (input) => {
        if (String(input).endsWith("/models")) {
          return new Response(JSON.stringify({ data: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }

        chatRequests += 1;
        return new Response(
          JSON.stringify({
            error: { message: "Upstream error from Nvidia: Service temporarily overloaded" },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      },
    });

    const request = {
      model: "kilo-auto/free",
      messages: [{ role: "user" as const, content: "review" }],
      routing: { task: "review_bug_hunter" },
    };

    await expect(client.createChatCompletion(request)).rejects.toThrow(
      "All adaptive free-model candidates failed",
    );
    await expect(client.createChatCompletion(request)).rejects.toThrow(
      "All adaptive free-model candidates failed",
    );
    await expect(client.createChatCompletion(request)).rejects.toThrow(
      "Auto Free circuit breaker open",
    );
    expect(chatRequests).toBe(2);
  });

  it("keeps transient explicit-model exclusion scoped to one review task", async () => {
    const requestedModels: string[] = [];
    let firstAttempt = true;

    const client = new AdaptiveFreeGatewayClient({
      maxRetries: 0,
      maxModelAttempts: 1,
      fetch: async (input, init) => {
        if (String(input).endsWith("/models")) {
          return new Response(
            JSON.stringify({
              data: [
                {
                  id: "provider/fast-model:free",
                  owned_by: "provider",
                  context_length: 131072,
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }

        const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
        requestedModels.push(String(body.model));
        if (firstAttempt) {
          firstAttempt = false;
          return new Response("temporarily unavailable", {
            status: 503,
            statusText: "Service Unavailable",
          });
        }
        return completion(String(body.model));
      },
    });

    await expect(
      client.createChatCompletion({
        model: "kilo-auto/free",
        messages: [{ role: "user", content: "general" }],
        routing: { task: "review_general" },
      }),
    ).rejects.toThrow();

    await expect(
      client.createChatCompletion({
        model: "kilo-auto/free",
        messages: [{ role: "user", content: "bug hunter" }],
        routing: { task: "review_bug_hunter" },
      }),
    ).resolves.toMatchObject({ routed_model: "provider/fast-model:free" });

    expect(requestedModels).toEqual(["provider/fast-model:free", "provider/fast-model:free"]);
  });

  it("shares validated structured-review success across review lenses", async () => {
    const requestedModels: string[] = [];

    const client = new AdaptiveFreeGatewayClient({
      maxRetries: 0,
      maxModelAttempts: 1,
      fetch: async (input, init) => {
        if (String(input).endsWith("/models")) {
          return new Response(
            JSON.stringify({
              data: [
                {
                  id: "provider/a:free",
                  owned_by: "provider-a",
                  context_length: 131072,
                },
                {
                  id: "provider/b:free",
                  owned_by: "provider-b",
                  context_length: 131072,
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }

        const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
        requestedModels.push(String(body.model));
        return completion(String(body.model));
      },
    });

    const first = await client.createChatCompletion({
      model: "kilo-auto/free",
      messages: [{ role: "user", content: "general" }],
      routing: { task: "review_general" },
    });
    const validatedModel = first.routed_model!;
    await client.reportModelSuccess({
      model: validatedModel,
      responseModel: first.model,
      task: "review_general",
    });

    requestedModels.length = 0;
    await client.createChatCompletion({
      model: "kilo-auto/free",
      messages: [{ role: "user", content: "security" }],
      routing: { task: "review_security" },
    });

    expect(requestedModels[0]).toBe(validatedModel);
  });

  it(
    "penalizes reasoning-heavy models for bounded review when no validated history exists",
    async () => {
    const requestedModels: string[] = [];

    const client = new AdaptiveFreeGatewayClient({
      maxRetries: 0,
      maxModelAttempts: 1,
      fetch: async (input, init) => {
        if (String(input).endsWith("/models")) {
          return new Response(
            JSON.stringify({
              data: [
                {
                  id: "provider/reasoning-model:free",
                  owned_by: "provider-a",
                  context_length: 131072,
                },
                {
                  id: "provider/standard-model:free",
                  owned_by: "provider-b",
                  context_length: 131072,
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }

        const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
        requestedModels.push(String(body.model));
        return completion(String(body.model));
      },
    });

    await client.createChatCompletion({
      model: "kilo-auto/free",
      messages: [{ role: "user", content: "review" }],
      routing: { task: "review_general" },
    });

    expect(requestedModels[0]).toBe("provider/standard-model:free");
    },
  );
});
