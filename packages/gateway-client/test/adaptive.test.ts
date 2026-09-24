import { describe, expect, it, vi } from "vitest";
import {
  AdaptiveFreeGatewayClient,
  type AdaptiveGatewayRouteEvent,
  type ReviewModelHistoryRecord,
} from "../src/adaptive.js";

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

    const now = Date.now();
    const client = new AdaptiveFreeGatewayClient({
      maxRetries: 0,
      maxModelAttempts: 4,
      requestTimeoutMs: 5_000,
      reviewHistory: [
        {
          model: "nvidia/mini-flash:free",
          task: "review_bug_hunter",
          validatedReports: 2,
          semanticFailures: 0,
          lengthFailures: 0,
          transportFailures: 0,
          lastValidatedAt: now,
          updatedAt: now,
        },
        {
          model: "z-ai/medium:free",
          task: "review_bug_hunter",
          validatedReports: 2,
          semanticFailures: 0,
          lengthFailures: 0,
          transportFailures: 0,
          lastValidatedAt: now,
          updatedAt: now,
        },
      ],
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

    await client.reportModelSuccess({
      model: response.routed_model ?? response.model,
      responseModel: response.model,
      task: "review_bug_hunter",
    });

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

  it("keeps a semantically invalid model eligible for later batches in the same review task", async () => {
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
                  id: "provider/recoverable:free",
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
        return completion(String(body.model));
      },
    });

    await client.reportModelFailure({
      model: "provider/recoverable:free",
      task: "review_general",
      reason: "invalid structured JSON",
    });

    await client.createChatCompletion({
      model: "kilo-auto/free",
      messages: [{ role: "user", content: "next batch" }],
      routing: { task: "review_general" },
    });

    expect(requestedModels[0]).toBe("provider/recoverable:free");
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

  it("retries a transient generic 429 after the short review cooldown", async () => {
    const requestedModels: string[] = [];
    const now = Date.now();
    let currentTime = now;
    let rateLimited = true;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => currentTime);

    try {
      const client = new AdaptiveFreeGatewayClient({
        maxRetries: 0,
        maxModelAttempts: 2,
        modelCooldownMs: 5 * 60_000,
        reviewHistory: [
          {
            model: "provider/rate-model:free",
            task: "review_general",
            validatedReports: 4,
            semanticFailures: 0,
            lengthFailures: 0,
            transportFailures: 0,
            lastValidatedAt: now,
            updatedAt: now,
          },
        ],
        fetch: async (input, init) => {
          if (String(input).endsWith("/models")) {
            return new Response(
              JSON.stringify({
                data: [
                  {
                    id: "provider/rate-model:free",
                    owned_by: "provider-a",
                    context_length: 131072,
                  },
                  {
                    id: "provider/fallback:free",
                    owned_by: "provider-b",
                    context_length: 131072,
                  },
                ],
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }

          const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
          const model = String(body.model);
          requestedModels.push(model);
          if (model === "provider/rate-model:free" && rateLimited) {
            rateLimited = false;
            return new Response(JSON.stringify({ error: { message: "Provider returned error" } }), {
              status: 429,
              statusText: "Too Many Requests",
              headers: { "Content-Type": "application/json" },
            });
          }
          return completion(model);
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
        messages: [{ role: "user", content: "during cooldown" }],
        routing: { task: "review_general" },
      });
      expect(requestedModels).not.toContain("provider/rate-model:free");

      currentTime += 61_000;
      requestedModels.length = 0;
      await client.createChatCompletion({
        model: "kilo-auto/free",
        messages: [{ role: "user", content: "after cooldown" }],
        routing: { task: "review_general" },
      });

      expect(requestedModels[0]).toBe("provider/rate-model:free");
    } finally {
      nowSpy.mockRestore();
    }
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
    const now = Date.now();

    const client = new AdaptiveFreeGatewayClient({
      maxRetries: 0,
      maxModelAttempts: 3,
      reviewHistory: [
        {
          model: "inclusionai/flash-fast:free",
          task: "review_general",
          validatedReports: 2,
          semanticFailures: 0,
          lengthFailures: 0,
          transportFailures: 0,
          lastValidatedAt: now,
          updatedAt: now,
        },
        {
          model: "other/mini:free",
          task: "review_general",
          validatedReports: 2,
          semanticFailures: 0,
          lengthFailures: 0,
          transportFailures: 0,
          lastValidatedAt: now,
          updatedAt: now,
        },
      ],
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

  it("uses prompt-only JSON when advertised model capabilities omit structured output", async () => {
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
  });

  it("preserves native structured output when the live catalog advertises response_format", async () => {
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
  });

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

  it("keeps the Auto Free circuit breaker scoped to one review task", async () => {
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
        if (chatRequests <= 2) {
          return new Response(
            JSON.stringify({
              error: { message: "Upstream error from Nvidia: Service temporarily overloaded" },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return completion("kilo-auto/free");
      },
    });

    const generalRequest = {
      model: "kilo-auto/free",
      messages: [{ role: "user" as const, content: "general" }],
      routing: { task: "review_general" },
    };

    await expect(client.createChatCompletion(generalRequest)).rejects.toThrow();
    await expect(client.createChatCompletion(generalRequest)).rejects.toThrow();
    await expect(client.createChatCompletion(generalRequest)).rejects.toThrow(
      "Auto Free circuit breaker open",
    );

    await expect(
      client.createChatCompletion({
        model: "kilo-auto/free",
        messages: [{ role: "user", content: "bug hunter" }],
        routing: { task: "review_bug_hunter" },
      }),
    ).resolves.toMatchObject({ routed_model: "kilo-auto/free" });
    expect(chatRequests).toBe(3);
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

  it("soft-penalizes transport failures across review lenses without globally excluding the model", async () => {
    const requestedModels: string[] = [];
    let failNext = true;

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
        if (failNext) {
          failNext = false;
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

    const failedModel = requestedModels[0];
    requestedModels.length = 0;

    await client.createChatCompletion({
      model: "kilo-auto/free",
      messages: [{ role: "user", content: "security" }],
      routing: { task: "review_security" },
    });

    expect(requestedModels[0]).not.toBe(failedModel);
  });

  it("excludes safety-only models from bounded review candidates", async () => {
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
                  id: "nvidia/content-safety-model:free",
                  owned_by: "nvidia",
                  context_length: 200000,
                },
                {
                  id: "provider/code-model:free",
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
        return completion(String(body.model));
      },
    });

    await client.createChatCompletion({
      model: "kilo-auto/free",
      messages: [{ role: "user", content: "review" }],
      routing: { task: "review_general" },
    });

    expect(requestedModels[0]).toBe("provider/code-model:free");
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

  it("penalizes semantic review failures across lenses without globally excluding the model", async () => {
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
    const failedModel = first.routed_model!;

    await client.reportModelFailure({
      model: failedModel,
      responseModel: first.model,
      task: "review_general",
      reason: "empty structured review content",
    });

    requestedModels.length = 0;
    await client.createChatCompletion({
      model: "kilo-auto/free",
      messages: [{ role: "user", content: "security" }],
      routing: { task: "review_security" },
    });

    expect(requestedModels[0]).not.toBe(failedModel);
  });

  it("retires a review model after repeated generation-length semantic failures with no validated success", async () => {
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
                  id: "provider/starved:free",
                  owned_by: "provider-a",
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
    await client.reportModelFailure({
      model: first.routed_model!,
      responseModel: first.model,
      task: "review_general",
      reason: "generation length limit reached without structured review content",
    });

    const second = await client.createChatCompletion({
      model: "kilo-auto/free",
      messages: [{ role: "user", content: "bug hunter" }],
      routing: { task: "review_bug_hunter" },
    });
    await client.reportModelFailure({
      model: second.routed_model!,
      responseModel: second.model,
      task: "review_bug_hunter",
      reason: "generation length limit reached without structured review content",
    });

    requestedModels.length = 0;
    await client.createChatCompletion({
      model: "kilo-auto/free",
      messages: [{ role: "user", content: "security" }],
      routing: { task: "review_security" },
    });

    expect(requestedModels[0]).toBe("kilo-auto/free");
  });

  it("keeps transient review transport failures recoverable across later lenses", async () => {
    const requestedModels: string[] = [];
    let failuresRemaining = 2;

    const client = new AdaptiveFreeGatewayClient({
      maxRetries: 0,
      maxModelAttempts: 1,
      fetch: async (input, init) => {
        if (String(input).endsWith("/models")) {
          return new Response(
            JSON.stringify({
              data: [
                {
                  id: "provider/dead:free",
                  owned_by: "provider-a",
                  context_length: 131072,
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }

        const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
        requestedModels.push(String(body.model));
        if (failuresRemaining > 0 && body.model === "provider/dead:free") {
          failuresRemaining -= 1;
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
    ).rejects.toThrow();

    requestedModels.length = 0;
    await client.createChatCompletion({
      model: "kilo-auto/free",
      messages: [{ role: "user", content: "security" }],
      routing: { task: "review_security" },
    });

    expect(requestedModels[0]).toBe("provider/dead:free");
  });

  it("keeps mixed-behavior review models eligible after a validated structured report", async () => {
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
                  id: "provider/mixed:free",
                  owned_by: "provider-a",
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

    const validated = await client.createChatCompletion({
      model: "kilo-auto/free",
      messages: [{ role: "user", content: "general" }],
      routing: { task: "review_general" },
    });
    await client.reportModelSuccess({
      model: validated.routed_model!,
      responseModel: validated.model,
      task: "review_general",
    });

    for (const task of ["review_bug_hunter", "review_security"]) {
      await client.reportModelFailure({
        model: validated.routed_model!,
        responseModel: validated.model,
        task,
        reason: "generation length limit reached without structured review content",
      });
    }

    requestedModels.length = 0;
    await client.createChatCompletion({
      model: "kilo-auto/free",
      messages: [{ role: "user", content: "follow-up" }],
      routing: { task: "review_follow_up" },
    });

    expect(requestedModels[0]).toBe("provider/mixed:free");
  });

  it("prioritizes persisted proven review models and bounds exploration", async () => {
    const requestedModels: string[] = [];
    const routeEvents: AdaptiveGatewayRouteEvent[] = [];
    const now = Date.now();

    const client = new AdaptiveFreeGatewayClient({
      maxRetries: 0,
      maxModelAttempts: 3,
      reviewHistory: [
        {
          model: "provider/proven:free",
          task: "review_general",
          validatedReports: 2,
          semanticFailures: 0,
          lengthFailures: 0,
          transportFailures: 0,
          lastValidatedAt: now,
          updatedAt: now,
        },
      ],
      reviewExplorationSlots: 1,
      onRoute: (event) => routeEvents.push(event),
      fetch: async (input, init) => {
        if (String(input).endsWith("/models")) {
          return new Response(
            JSON.stringify({
              data: [
                {
                  id: "provider/proven:free",
                  owned_by: "provider-a",
                  context_length: 131072,
                },
                {
                  id: "provider/explore-fast:free",
                  owned_by: "provider-b",
                  context_length: 131072,
                },
                {
                  id: "provider/unproven-extra:free",
                  owned_by: "provider-c",
                  context_length: 131072,
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }

        const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
        const model = String(body.model);
        requestedModels.push(model);
        if (model === "provider/proven:free") {
          return new Response("temporarily unavailable", {
            status: 503,
            statusText: "Service Unavailable",
          });
        }
        return completion(model);
      },
    });

    await expect(
      client.createChatCompletion({
        model: "kilo-auto/free",
        messages: [{ role: "user", content: "review" }],
        routing: { task: "review_general" },
      }),
    ).resolves.toMatchObject({ routed_model: "provider/explore-fast:free" });

    expect(requestedModels).toEqual(["provider/proven:free", "provider/explore-fast:free"]);
    expect(routeEvents).toContainEqual({
      type: "review-history",
      task: "review_general",
      trustedModels: ["provider/proven:free"],
      mixedModels: [],
      explorationModels: ["provider/explore-fast:free"],
    });
    expect(requestedModels).not.toContain("provider/unproven-extra:free");
  });

  it("keeps flaky historically validated models in Tier B instead of Tier A", async () => {
    const routeEvents: AdaptiveGatewayRouteEvent[] = [];
    const now = Date.now();

    const client = new AdaptiveFreeGatewayClient({
      maxRetries: 0,
      maxModelAttempts: 1,
      reviewHistory: [
        {
          model: "provider/flaky:free",
          task: "review_general",
          validatedReports: 4,
          semanticFailures: 4,
          lengthFailures: 2,
          transportFailures: 1,
          lastValidatedAt: now,
          updatedAt: now,
        },
      ],
      onRoute: (event) => routeEvents.push(event),
      fetch: async (input, init) => {
        if (String(input).endsWith("/models")) {
          return new Response(
            JSON.stringify({
              data: [
                {
                  id: "provider/flaky:free",
                  owned_by: "provider",
                  context_length: 131072,
                },
                {
                  id: "provider/explore:free",
                  owned_by: "other",
                  context_length: 131072,
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }

        const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
        return completion(String(body.model));
      },
    });

    await client.createChatCompletion({
      model: "kilo-auto/free",
      messages: [{ role: "user", content: "review" }],
      routing: { task: "review_general" },
    });

    expect(routeEvents).toContainEqual({
      type: "review-history",
      task: "review_general",
      trustedModels: [],
      mixedModels: ["provider/flaky:free"],
      explorationModels: ["provider/explore:free"],
    });
  });

  it("uses the review attempt budget on proven Tier B models before exploration or Auto Free", async () => {
    const requestedModels: string[] = [];
    const now = Date.now();

    const client = new AdaptiveFreeGatewayClient({
      maxRetries: 0,
      maxModelAttempts: 3,
      reviewExplorationSlots: 1,
      reviewHistory: [
        {
          model: "provider/mixed-a:free",
          task: "review_general",
          validatedReports: 4,
          semanticFailures: 0,
          lengthFailures: 0,
          transportFailures: 0,
          lastValidatedAt: now,
          updatedAt: now,
        },
        {
          model: "provider/mixed-b:free",
          task: "review_security",
          validatedReports: 4,
          semanticFailures: 0,
          lengthFailures: 0,
          transportFailures: 0,
          lastValidatedAt: now,
          updatedAt: now,
        },
      ],
      fetch: async (input, init) => {
        if (String(input).endsWith("/models")) {
          return new Response(
            JSON.stringify({
              data: [
                {
                  id: "provider/mixed-a:free",
                  owned_by: "provider-a",
                  context_length: 131072,
                },
                {
                  id: "provider/mixed-b:free",
                  owned_by: "provider-b",
                  context_length: 131072,
                },
                {
                  id: "provider/explore:free",
                  owned_by: "provider-c",
                  context_length: 131072,
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }

        const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
        const model = String(body.model);
        requestedModels.push(model);
        if (model.includes("mixed-")) {
          return new Response("temporarily unavailable", {
            status: 503,
            statusText: "Service Unavailable",
          });
        }
        return completion(model);
      },
    });

    await expect(
      client.createChatCompletion({
        model: "kilo-auto/free",
        messages: [{ role: "user", content: "review" }],
        routing: { task: "review_bug_hunter" },
      }),
    ).resolves.toMatchObject({ routed_model: "provider/explore:free" });

    expect(requestedModels.filter((model) => model.includes("mixed-"))).toHaveLength(2);
    expect(requestedModels.at(-1)).toBe("provider/explore:free");
    expect(requestedModels).not.toContain("kilo-auto/free");
  });

  it("does not reserve an Auto Free slot when enough trusted review models exist", async () => {
    const requestedModels: string[] = [];
    const now = Date.now();

    const client = new AdaptiveFreeGatewayClient({
      maxRetries: 0,
      maxModelAttempts: 3,
      reviewHistory: ["a", "b", "c"].map((suffix) => ({
        model: "provider-" + suffix + "/trusted:free",
        task: "review_security",
        validatedReports: 3,
        semanticFailures: 0,
        lengthFailures: 0,
        transportFailures: 0,
        lastValidatedAt: now,
        updatedAt: now,
      })),
      fetch: async (input, init) => {
        if (String(input).endsWith("/models")) {
          return new Response(
            JSON.stringify({
              data: ["a", "b", "c"].map((suffix) => ({
                id: "provider-" + suffix + "/trusted:free",
                owned_by: "provider-" + suffix,
                context_length: 131072,
              })),
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }

        const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
        const model = String(body.model);
        requestedModels.push(model);
        if (requestedModels.length < 3) {
          return new Response("temporarily unavailable", {
            status: 503,
            statusText: "Service Unavailable",
          });
        }
        return completion(model);
      },
    });

    await client.createChatCompletion({
      model: "kilo-auto/free",
      messages: [{ role: "user", content: "review" }],
      routing: { task: "review_security" },
    });

    expect(requestedModels).toHaveLength(3);
    expect(requestedModels.every((model) => model.endsWith("/trusted:free"))).toBe(true);
    expect(requestedModels).not.toContain("kilo-auto/free");
  });

  it("bounds a review cold start to one exploration model plus Auto Free", async () => {
    const requestedModels: string[] = [];

    const client = new AdaptiveFreeGatewayClient({
      maxRetries: 0,
      maxModelAttempts: 3,
      reviewExplorationSlots: 1,
      fetch: async (input, init) => {
        if (String(input).endsWith("/models")) {
          return new Response(
            JSON.stringify({
              data: [
                {
                  id: "provider/first:free",
                  owned_by: "provider-a",
                  context_length: 131072,
                },
                {
                  id: "provider/second:free",
                  owned_by: "provider-b",
                  context_length: 131072,
                },
                {
                  id: "provider/third:free",
                  owned_by: "provider-c",
                  context_length: 131072,
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }

        const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
        const model = String(body.model);
        requestedModels.push(model);
        if (model !== "kilo-auto/free") {
          return new Response("temporarily unavailable", {
            status: 503,
            statusText: "Service Unavailable",
          });
        }
        return completion(model);
      },
    });

    await client.createChatCompletion({
      model: "kilo-auto/free",
      messages: [{ role: "user", content: "review" }],
      routing: { task: "review_general" },
    });

    expect(requestedModels).toHaveLength(2);
    expect(requestedModels[1]).toBe("kilo-auto/free");
    expect(requestedModels).not.toContain("provider/third:free");
  });

  it("persists validated review history through the history callback", async () => {
    let persisted: ReviewModelHistoryRecord[] = [];

    const client = new AdaptiveFreeGatewayClient({
      maxRetries: 0,
      maxModelAttempts: 1,
      onReviewHistoryChange: (history) => {
        persisted = history;
      },
      fetch: async (input, init) => {
        if (String(input).endsWith("/models")) {
          return new Response(
            JSON.stringify({
              data: [
                {
                  id: "provider/validated:free",
                  owned_by: "provider",
                  context_length: 131072,
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
        return completion(String(body.model));
      },
    });

    const response = await client.createChatCompletion({
      model: "kilo-auto/free",
      messages: [{ role: "user", content: "review" }],
      routing: { task: "review_security" },
    });

    await client.reportModelSuccess({
      model: response.routed_model!,
      responseModel: response.model,
      task: "review_security",
    });

    expect(persisted).toEqual([
      expect.objectContaining({
        model: "provider/validated:free",
        task: "review_security",
        validatedReports: 1,
        semanticFailures: 0,
        lengthFailures: 0,
        transportFailures: 0,
      }),
    ]);
    expect(persisted[0]?.lastValidatedAt).toEqual(expect.any(Number));
  });

  it("does not treat generic reasoning capability metadata as reasoning-heavy", async () => {
    const requestedModels: string[] = [];
    const attempts: Array<{ candidateModel: string; reasoningModel?: boolean }> = [];

    const client = new AdaptiveFreeGatewayClient({
      maxRetries: 0,
      maxModelAttempts: 1,
      onRoute: (event) => {
        if (event.type === "attempt") {
          attempts.push({
            candidateModel: event.candidateModel,
            reasoningModel: event.reasoningModel,
          });
        }
      },
      fetch: async (input, init) => {
        if (String(input).endsWith("/models")) {
          return new Response(
            JSON.stringify({
              data: [
                {
                  id: "provider/flash-model:free",
                  owned_by: "provider-a",
                  context_length: 131072,
                  supported_features: ["reasoning"],
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

    expect(requestedModels[0]).toBe("provider/flash-model:free");
    expect(attempts[0]).toEqual({
      candidateModel: "provider/flash-model:free",
      reasoningModel: false,
    });
  });

  it("penalizes reasoning-heavy models for bounded review when no validated history exists", async () => {
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
  });
});
