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

});
