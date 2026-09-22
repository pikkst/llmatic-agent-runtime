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

function responseErrorMessage(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;

  const object = value as Record<string, unknown>;
  const error = object.error;
  if (typeof error === "string" && error.trim()) return error.trim();

  if (error && typeof error === "object") {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === "string" && message.trim()) return message.trim();
  }

  if (!("choices" in object) && typeof object.message === "string" && object.message.trim()) {
    return object.message.trim();
  }

  return undefined;
}

function responseShape(value: unknown): string {
  if (!value || typeof value !== "object") {
    return "payload=" + (value === null ? "null" : typeof value);
  }

  const object = value as Record<string, unknown>;
  const keys = Object.keys(object).slice(0, 12);
  const model = typeof object.model === "string" ? object.model : undefined;
  const objectType = typeof object.object === "string" ? object.object : undefined;
  const choices = Array.isArray(object.choices) ? object.choices : undefined;
  const firstChoice =
    choices?.[0] && typeof choices[0] === "object"
      ? (choices[0] as Record<string, unknown>)
      : undefined;

  return [
    model ? "model=" + model : undefined,
    objectType ? "object=" + objectType : undefined,
    choices ? "choices=" + choices.length : undefined,
    firstChoice ? "choiceKeys=" + Object.keys(firstChoice).slice(0, 8).join(",") : undefined,
    "keys=" + keys.join(","),
  ]
    .filter((item): item is string => Boolean(item))
    .join("; ");
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

    let parsed: unknown;

    try {
      parsed = JSON.parse(raw) as unknown;
    } catch (error) {
      throw new Error(
        "Kilo Gateway returned invalid JSON: " +
          (error instanceof Error ? error.message : String(error)),
      );
    }

    const gatewayError = responseErrorMessage(parsed);
    if (gatewayError) {
      throw new Error("Kilo Gateway returned an error payload: " + gatewayError.slice(0, 500));
    }

    const responseBody = parsed as Partial<GatewayChatResponse>;
    if (!responseBody.choices?.[0]?.message) {
      throw new Error(
        "Kilo Gateway returned a 2xx response without choices[0].message (" +
          responseShape(parsed) +
          ").",
      );
    }

    return responseBody as GatewayChatResponse;
  }
}
