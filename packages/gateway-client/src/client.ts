import type { GatewayChatRequest, GatewayChatResponse, GatewayFetch } from "./types.js";

const DEFAULT_BASE_URL = "https://api.kilo.ai/api/gateway";

export interface KiloGatewayClientOptions {
  apiKey?: string;
  baseUrl?: string;
  organizationId?: string;
  fetch?: GatewayFetch;
}

export interface GatewayChatClient {
  createChatCompletion(request: GatewayChatRequest): Promise<GatewayChatResponse>;
}

export class KiloGatewayClient implements GatewayChatClient {
  private readonly apiKey?: string;
  private readonly baseUrl: string;
  private readonly organizationId?: string;
  private readonly request: GatewayFetch;

  public constructor(options: KiloGatewayClientOptions) {
    this.apiKey = options.apiKey?.trim() || undefined;
    this.baseUrl = (options.baseUrl?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.organizationId = options.organizationId?.trim() || undefined;
    this.request = options.fetch ?? fetch;
  }

  public async createChatCompletion(request: GatewayChatRequest): Promise<GatewayChatResponse> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };

    if (this.apiKey) headers.Authorization = "Bearer " + this.apiKey;
    if (this.organizationId) {
      headers["X-KiloCode-OrganizationId"] = this.organizationId;
    }
    if (request.mode?.trim()) {
      headers["x-kilocode-mode"] = request.mode.trim();
    }

    const response = await this.request(this.baseUrl + "/chat/completions", {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: request.model,
        messages: request.messages,
        tools: request.tools,
        max_tokens: request.max_tokens,
        temperature: request.temperature,
        stream: false,
      }),
    });

    const raw = await response.text();

    if (!response.ok) {
      let detail = raw.trim();

      try {
        const parsed = JSON.parse(raw) as { error?: { message?: string } };
        detail = parsed.error?.message ?? detail;
      } catch {
        // Preserve the raw response when the gateway did not return JSON.
      }

      throw new Error(
        "Kilo Gateway request failed with " +
          response.status +
          " " +
          response.statusText +
          (detail ? ": " + detail.slice(0, 500) : ""),
      );
    }

    let parsed: GatewayChatResponse;

    try {
      parsed = JSON.parse(raw) as GatewayChatResponse;
    } catch (error) {
      throw new Error(
        "Kilo Gateway returned invalid JSON: " +
          (error instanceof Error ? error.message : String(error)),
      );
    }

    if (!parsed.choices?.[0]?.message) {
      throw new Error("Kilo Gateway response did not include an assistant message.");
    }

    return parsed;
  }
}
