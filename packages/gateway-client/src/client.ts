import type {
  GatewayChatRequest,
  GatewayChatResponse,
  GatewayFetch,
  GatewayModelInfo,
} from "./types.js";

const DEFAULT_BASE_URL = "https://api.kilo.ai/api/gateway";

export interface GatewayRetryEvent {
  nextAttempt: number;
  maxAttempts: number;
  delayMs: number;
  reason: string;
  status?: number;
}

export interface KiloGatewayClientOptions {
  apiKey?: string;
  baseUrl?: string;
  organizationId?: string;
  fetch?: GatewayFetch;
  maxRetries?: number;
  retryBaseDelayMs?: number;
  requestTimeoutMs?: number;
  sleep?: (delayMs: number) => Promise<void>;
  onRetry?: (event: GatewayRetryEvent) => void | Promise<void>;
}

export interface GatewayModelFailureFeedback {
  model: string;
  task?: string;
  reason: string;
}

export interface GatewayChatClient {
  createChatCompletion(request: GatewayChatRequest): Promise<GatewayChatResponse>;
  reportModelFailure?(
    feedback: GatewayModelFailureFeedback,
  ): void | Promise<void>;
}

class RetryableGatewayError extends Error {
  public constructor(
    message: string,
    public readonly retryable: boolean,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "RetryableGatewayError";
  }
}

function isTransientStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function isTransientGatewayMessage(message: string): boolean {
  return /temporar(?:y|ily)|overload(?:ed)?|rate.?limit|too many requests|timeout|timed out|upstream.*unavailable|service.*unavailable|try again/i.test(
    message,
  );
}

function defaultSleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
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
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly requestTimeoutMs: number;
  private readonly sleep: (delayMs: number) => Promise<void>;
  private readonly onRetry?: (event: GatewayRetryEvent) => void | Promise<void>;

  public constructor(options: KiloGatewayClientOptions) {
    this.apiKey = options.apiKey?.trim() || undefined;
    this.baseUrl = (options.baseUrl?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.organizationId = options.organizationId?.trim() || undefined;
    this.request = options.fetch ?? fetch;
    this.maxRetries = Math.max(0, Math.min(5, Math.trunc(options.maxRetries ?? 2)));
    this.retryBaseDelayMs = Math.max(0, Math.trunc(options.retryBaseDelayMs ?? 500));
    this.requestTimeoutMs = Math.max(
      1_000,
      Math.min(10 * 60_000, Math.trunc(options.requestTimeoutMs ?? 120_000)),
    );
    this.sleep = options.sleep ?? defaultSleep;
    this.onRetry = options.onRetry;
  }

  public async listModels(): Promise<GatewayModelInfo[]> {
    const controller = new AbortController();
    const catalogTimeoutMs = Math.min(this.requestTimeoutMs, 10_000);
    const timeout = setTimeout(() => controller.abort(), catalogTimeoutMs);

    try {
      const response = await this.request(this.baseUrl + "/models", {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(
          "Kilo Gateway model catalog failed with " +
            response.status +
            " " +
            response.statusText +
            ".",
        );
      }

      const parsed = (await response.json()) as { data?: unknown };
      if (!Array.isArray(parsed.data)) {
        throw new Error("Kilo Gateway model catalog did not return a data array.");
      }

      return parsed.data.filter((model): model is GatewayModelInfo =>
        Boolean(
          model &&
          typeof model === "object" &&
          typeof (model as Record<string, unknown>).id === "string",
        ),
      );
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error("Kilo Gateway model catalog timed out after " + catalogTimeoutMs + "ms.");
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  public async createChatCompletion(request: GatewayChatRequest): Promise<GatewayChatResponse> {
    const maxAttempts = this.maxRetries + 1;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await this.createChatCompletionAttempt(request);
      } catch (error) {
        const retryable = error instanceof RetryableGatewayError && error.retryable;
        if (!retryable || attempt >= maxAttempts) throw error;

        const delayMs = Math.min(
          this.retryBaseDelayMs * 2 ** (attempt - 1),
          Math.max(this.retryBaseDelayMs, 4_000),
        );
        const reason = error instanceof Error ? error.message : String(error);

        await this.onRetry?.({
          nextAttempt: attempt + 1,
          maxAttempts,
          delayMs,
          reason,
          status: error instanceof RetryableGatewayError ? error.status : undefined,
        });
        await this.sleep(delayMs);
      }
    }

    throw new Error("Kilo Gateway retry loop exited unexpectedly.");
  }

  private async createChatCompletionAttempt(
    request: GatewayChatRequest,
  ): Promise<GatewayChatResponse> {
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

    let response: Response;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);

    try {
      response = await this.request(this.baseUrl + "/chat/completions", {
        method: "POST",
        headers,
        signal: controller.signal,
        body: JSON.stringify({
          model: request.model,
          messages: request.messages,
          tools: request.tools,
          tool_choice: request.tool_choice,
          response_format: request.response_format,
          max_tokens: request.max_tokens,
          temperature: request.temperature,
          stream: false,
        }),
      });
    } catch (error) {
      const timedOut = controller.signal.aborted;
      throw new RetryableGatewayError(
        timedOut
          ? "Kilo Gateway request timed out after " + this.requestTimeoutMs + "ms."
          : "Kilo Gateway network request failed: " +
              (error instanceof Error ? error.message : String(error)),
        true,
      );
    } finally {
      clearTimeout(timeout);
    }

    const raw = await response.text();

    if (!response.ok) {
      let detail = raw.trim();

      try {
        const parsed = JSON.parse(raw) as { error?: { message?: string } };
        detail = parsed.error?.message ?? detail;
      } catch {
        // Preserve the raw response when the gateway did not return JSON.
      }

      const message =
        "Kilo Gateway request failed with " +
        response.status +
        " " +
        response.statusText +
        (detail ? ": " + detail.slice(0, 500) : "");

      throw new RetryableGatewayError(
        message,
        isTransientStatus(response.status) || isTransientGatewayMessage(detail),
        response.status,
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
      throw new RetryableGatewayError(
        "Kilo Gateway returned an error payload: " + gatewayError.slice(0, 500),
        isTransientGatewayMessage(gatewayError),
        response.status,
      );
    }

    const responseBody = parsed as Partial<GatewayChatResponse>;
    if (!responseBody.choices?.[0]?.message) {
      throw new RetryableGatewayError(
        "Kilo Gateway returned a 2xx response without choices[0].message (" +
          responseShape(parsed) +
          ").",
        true,
        response.status,
      );
    }

    return responseBody as GatewayChatResponse;
  }
}
