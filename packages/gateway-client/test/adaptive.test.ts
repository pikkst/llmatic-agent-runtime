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
                  id: "nvidia/large:free",
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
        if (body.model === "nvidia/large:free") {
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
    expect(requestedModels).toEqual(["nvidia/large:free", "z-ai/medium:free"]);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "catalog" }),
        expect.objectContaining({
          type: "failure",
          candidateModel: "nvidia/large:free",
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
});
