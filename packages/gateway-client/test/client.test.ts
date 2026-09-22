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
});
