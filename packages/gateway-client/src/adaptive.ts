import {
  KiloGatewayClient,
  type GatewayChatClient,
  type GatewayModelFailureFeedback,
  type GatewayModelSuccessFeedback,
  type KiloGatewayClientOptions,
} from "./client.js";
import type { GatewayChatRequest, GatewayChatResponse, GatewayModelInfo } from "./types.js";

export type AdaptiveGatewayRouteEvent =
  | {
      type: "catalog";
      freeModelCount: number;
      durationMs: number;
    }
  | {
      type: "attempt";
      task: string;
      candidateModel: string;
      attempt: number;
      maxAttempts: number;
      structuredOutputMode?: "native" | "prompt_only";
      reasoningModel?: boolean;
    }
  | {
      type: "success";
      task: string;
      candidateModel: string;
      responseModel: string;
      attempt: number;
      latencyMs: number;
    }
  | {
      type: "failure";
      task: string;
      candidateModel: string;
      attempt: number;
      latencyMs: number;
      reason: string;
    };

export interface AdaptiveFreeGatewayClientOptions extends KiloGatewayClientOptions {
  maxModelAttempts?: number;
  catalogTtlMs?: number;
  modelCooldownMs?: number;
  onRoute?: (event: AdaptiveGatewayRouteEvent) => void | Promise<void>;
}

interface ModelStats {
  transportAttempts: number;
  transportSuccesses: number;
  validatedSuccesses: number;
  failures: number;
  totalLatencyMs: number;
}

const AUTO_FREE_SESSION_FAILURE_LIMIT = 2;

function isFreeModelId(model: string): boolean {
  return model === "kilo-auto/free" || model.endsWith(":free");
}

function stableHash(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function fallbackEligible(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /timed? out|timeout|temporar|overload|rate.?limit|too many requests|\b429\b|\b500\b|\b502\b|\b503\b|upstream|service.*unavailable|without choices|invalid json|unsupported|not support|response.?format|tool.?choice|context.*window|context.*length|exceeds.*context|no compatible free model|400 Bad Request: Provider returned error/i.test(
    message,
  );
}

function providerCompatibilityFailure(reason: string): boolean {
  return /400 Bad Request: Provider returned error|unsupported|not support|response.?format|tool.?choice/i.test(
    reason,
  );
}

function providerKey(model: GatewayModelInfo | string): string {
  if (typeof model === "string") return model.split("/")[0] || model;
  return model.owned_by?.trim() || model.id.split("/")[0] || model.id;
}

function modelFeatureTokens(model: GatewayModelInfo): Set<string> {
  const source = model as Record<string, unknown>;
  const values = [
    source.supported_features,
    source.supportedFeatures,
    source.features,
    source.capabilities,
    source.supported_parameters,
    source.supportedParameters,
  ];
  const tokens = new Set<string>();

  const visit = (value: unknown, depth: number): void => {
    if (depth > 3 || value === null || value === undefined) return;
    if (typeof value === "string") {
      for (const token of value.toLowerCase().split(/[^a-z0-9_]+/).filter(Boolean)) {
        tokens.add(token);
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (typeof value !== "object") return;

    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      const normalizedKey = key.toLowerCase();
      if (nested === true) tokens.add(normalizedKey);
      visit(nested, depth + 1);
    }
  };

  for (const value of values) visit(value, 0);
  return tokens;
}

function structuredOutputSupport(model: GatewayModelInfo): "supported" | "unsupported" | "unknown" {
  const source = model as Record<string, unknown>;
  const parameterSource = source.supported_parameters ?? source.supportedParameters;
  const parameterTokens = new Set<string>();

  const collectParameters = (value: unknown): void => {
    if (typeof value === "string") {
      for (const token of value.toLowerCase().split(/[^a-z0-9_]+/).filter(Boolean)) {
        parameterTokens.add(token);
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) collectParameters(item);
      return;
    }
    if (value && typeof value === "object") {
      for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
        if (nested === true) parameterTokens.add(key.toLowerCase());
      }
    }
  };

  collectParameters(parameterSource);
  const structuredPattern =
    /^(?:response_format|responseformat|structured_output|structured_outputs|structuredoutput|json_object|json_schema|json)$/;

  if ([...parameterTokens].some((token) => structuredPattern.test(token))) {
    return "supported";
  }
  if (parameterTokens.size > 0) {
    return "unsupported";
  }

  const featureTokens = modelFeatureTokens(model);
  return [...featureTokens].some((token) => structuredPattern.test(token))
    ? "supported"
    : "unknown";
}

function reasoningHeavyModel(model: GatewayModelInfo): boolean {
  const id = (model.id + " " + (model.name ?? "")).toLowerCase();
  if (/reasoning|thinking|(?:^|[\/_-])r1(?:[\/_:-]|$)|\bqwq\b/.test(id)) return true;

  const tokens = modelFeatureTokens(model);
  return [...tokens].some((token) => /reasoning|thinking/.test(token));
}

function reviewSpeedScore(model: GatewayModelInfo): number {
  const id = model.id.toLowerCase();
  let score = 0;
  if (/flash|lightning|fast/.test(id)) score += 120;
  if (/mini|small|lite|\bxs\b/.test(id)) score += 80;
  if (/ultra|max|550b/.test(id)) score -= 160;
  if (/large|120b/.test(id)) score -= 80;
  if (/vl|vision|image|audio|speech|embedding/.test(id)) score -= 120;
  if (/content.?safety|moderation|guard/.test(id)) score -= 500;
  if (reasoningHeavyModel(model)) score -= 220;
  return score;
}

function autoFreeCircuitBreakerFailure(reason: string): boolean {
  return /timed? out|timeout|temporar|overload|resourceexhausted|resource exhausted|upstream.*unavailable|service.*unavailable/i.test(
    reason,
  );
}

function cooldownForFailure(reason: string, fallbackMs: number): number {
  if (/daily limit|limit_rpd|per day|rpd/i.test(reason)) return 24 * 60 * 60_000;
  if (/rate.?limit|too many requests|\b429\b/i.test(reason)) {
    return Math.max(fallbackMs, 30 * 60_000);
  }
  return fallbackMs;
}

function modelContextLength(model: GatewayModelInfo): number {
  return typeof model.context_length === "number" && Number.isFinite(model.context_length)
    ? model.context_length
    : 0;
}

export class AdaptiveFreeGatewayClient implements GatewayChatClient {
  private readonly client: KiloGatewayClient;
  private readonly maxModelAttempts: number;
  private readonly catalogTtlMs: number;
  private readonly modelCooldownMs: number;
  private readonly onRoute?: (event: AdaptiveGatewayRouteEvent) => void | Promise<void>;
  private catalog?: GatewayModelInfo[];
  private catalogExpiresAt = 0;
  private readonly stats = new Map<string, Map<string, ModelStats>>();
  private readonly validatedReviewSuccesses = new Map<string, number>();
  private readonly taskUnhealthyUntil = new Map<string, Map<string, number>>();
  private readonly globallyUnhealthyUntil = new Map<string, number>();
  private readonly taskExcludedModels = new Map<string, Set<string>>();
  private readonly blockedProviders = new Set<string>();
  private autoFreeSessionFailures = 0;
  private autoFreeDisabled = false;

  public constructor(options: AdaptiveFreeGatewayClientOptions) {
    this.client = new KiloGatewayClient(options);
    this.maxModelAttempts = Math.max(1, Math.min(8, Math.trunc(options.maxModelAttempts ?? 4)));
    this.catalogTtlMs = Math.max(30_000, Math.trunc(options.catalogTtlMs ?? 5 * 60_000));
    this.modelCooldownMs = Math.max(30_000, Math.trunc(options.modelCooldownMs ?? 5 * 60_000));
    this.onRoute = options.onRoute;
  }

  public async reportModelFailure(feedback: GatewayModelFailureFeedback): Promise<void> {
    const model = feedback.model.trim();
    if (!model) return;

    const task = feedback.task?.trim() || "generic";
    for (const candidate of this.feedbackModels(model, feedback.responseModel)) {
      this.recordSemanticFailure(task, candidate);
      if (candidate !== "kilo-auto/free" && isFreeModelId(candidate)) {
        this.excludeForTask(task, candidate, feedback.reason);
      }
    }

    await this.onRoute?.({
      type: "failure",
      task,
      candidateModel: model,
      attempt: 0,
      latencyMs: 0,
      reason: "semantic contract failure: " + feedback.reason,
    });
  }

  public async reportModelSuccess(feedback: GatewayModelSuccessFeedback): Promise<void> {
    const model = feedback.model.trim();
    if (!model) return;

    const task = feedback.task?.trim() || "generic";
    for (const candidate of this.feedbackModels(model, feedback.responseModel)) {
      this.recordValidatedSuccess(task, candidate);
      this.clearTaskFailure(task, candidate);
    }
  }

  public async createChatCompletion(request: GatewayChatRequest): Promise<GatewayChatResponse> {
    if (!isFreeModelId(request.model)) {
      return this.client.createChatCompletion(request);
    }

    const task = request.routing?.task?.trim() || "generic";
    const candidates = await this.modelCandidates(request, task);
    let lastError: unknown;

    for (let index = 0; index < candidates.length; index += 1) {
      const candidateModel = candidates[index]!;
      const attempt = index + 1;
      const candidateInfo = this.catalog?.find((model) => model.id === candidateModel);
      const structuredSupport =
        candidateModel === "kilo-auto/free"
          ? "unsupported"
          : candidateInfo
            ? structuredOutputSupport(candidateInfo)
            : "unknown";
      const structuredOutputMode = request.response_format
        ? structuredSupport === "unsupported"
          ? "prompt_only"
          : "native"
        : undefined;
      const reasoningModel = candidateInfo ? reasoningHeavyModel(candidateInfo) : false;

      await this.onRoute?.({
        type: "attempt",
        task,
        candidateModel,
        attempt,
        maxAttempts: candidates.length,
        structuredOutputMode,
        reasoningModel,
      });

      const startedAt = Date.now();
      try {
        const response = await this.client.createChatCompletion({
          ...request,
          model: candidateModel,
          response_format:
            structuredOutputMode === "prompt_only" ? undefined : request.response_format,
        });
        const latencyMs = Date.now() - startedAt;
        this.recordTransport(task, candidateModel, true, latencyMs);
        this.clearTaskFailure(task, candidateModel);
        await this.onRoute?.({
          type: "success",
          task,
          candidateModel,
          responseModel: response.model || candidateModel,
          attempt,
          latencyMs,
        });
        return {
          ...response,
          routed_model: candidateModel,
        };
      } catch (error) {
        const latencyMs = Date.now() - startedAt;
        this.recordTransport(task, candidateModel, false, latencyMs);
        const reason = error instanceof Error ? error.message : String(error);
        await this.onRoute?.({
          type: "failure",
          task,
          candidateModel,
          attempt,
          latencyMs,
          reason,
        });
        lastError = error;

        if (!fallbackEligible(error)) throw error;

        if (candidateModel === "kilo-auto/free") {
          if (autoFreeCircuitBreakerFailure(reason)) {
            this.autoFreeSessionFailures += 1;
            if (this.autoFreeSessionFailures >= AUTO_FREE_SESSION_FAILURE_LIMIT) {
              this.autoFreeDisabled = true;
            }
          }
        } else {
          this.excludeForTask(task, candidateModel, reason);
          if (providerCompatibilityFailure(reason)) {
            this.blockedProviders.add(providerKey(candidateModel));
          }
        }
      }
    }

    throw lastError instanceof Error
      ? new Error(
          "All adaptive free-model candidates failed for " + task + ": " + lastError.message,
        )
      : new Error("All adaptive free-model candidates failed for " + task + ".");
  }

  private async modelCandidates(request: GatewayChatRequest, task: string): Promise<string[]> {
    const avoided = new Set(request.routing?.avoidModels ?? []);
    const requested = request.model.trim() || "kilo-auto/free";
    const candidates: string[] = [];
    const taskExcluded = this.taskExcludedModels.get(task);
    const taskUnhealthy = this.taskUnhealthyUntil.get(task);

    if (
      requested !== "kilo-auto/free" &&
      !avoided.has(requested) &&
      !taskExcluded?.has(requested) &&
      !this.blockedProviders.has(providerKey(requested)) &&
      (taskUnhealthy?.get(requested) ?? 0) <= Date.now() &&
      (this.globallyUnhealthyUntil.get(requested) ?? 0) <= Date.now()
    ) {
      candidates.push(requested);
    }

    try {
      const models = await this.freeModels();
      const now = Date.now();
      const ranked = [...models]
        .filter(
          (model) =>
            !avoided.has(model.id) &&
            !taskExcluded?.has(model.id) &&
            !this.blockedProviders.has(providerKey(model)) &&
            (taskUnhealthy?.get(model.id) ?? 0) <= now &&
            (this.globallyUnhealthyUntil.get(model.id) ?? 0) <= now,
        )
        .sort((left, right) => this.score(task, right) - this.score(task, left));

      const usedProviders = new Set<string>();
      const diverse: GatewayModelInfo[] = [];
      const remainder: GatewayModelInfo[] = [];

      for (const model of ranked) {
        const provider = providerKey(model);
        if (!usedProviders.has(provider)) {
          usedProviders.add(provider);
          diverse.push(model);
        } else {
          remainder.push(model);
        }
      }

      for (const model of [...diverse, ...remainder]) {
        if (!candidates.includes(model.id)) candidates.push(model.id);
      }
    } catch {
      // Live discovery is an optimization. Preserve Auto Free only while its circuit is closed.
    }

    const autoFreeAllowed = !avoided.has("kilo-auto/free") && !this.autoFreeDisabled;
    if (autoFreeAllowed && !candidates.includes("kilo-auto/free")) {
      candidates.push("kilo-auto/free");
    }

    if (candidates.length === 0) {
      throw new Error(
        "No compatible free-model candidates remain for " +
          task +
          (this.autoFreeDisabled ? " (Auto Free circuit breaker open)." : "."),
      );
    }

    if (this.maxModelAttempts === 1) {
      return [candidates[0]!];
    }

    if (autoFreeAllowed && candidates.includes("kilo-auto/free")) {
      return [
        ...candidates
          .filter((model) => model !== "kilo-auto/free")
          .slice(0, this.maxModelAttempts - 1),
        "kilo-auto/free",
      ];
    }

    return candidates.slice(0, this.maxModelAttempts);
  }

  private async freeModels(): Promise<GatewayModelInfo[]> {
    if (this.catalog && Date.now() < this.catalogExpiresAt) {
      return this.catalog;
    }

    const startedAt = Date.now();
    const catalog = await this.client.listModels();
    this.catalog = catalog.filter((model) => model.id.endsWith(":free"));
    this.catalogExpiresAt = Date.now() + this.catalogTtlMs;

    await this.onRoute?.({
      type: "catalog",
      freeModelCount: this.catalog.length,
      durationMs: Date.now() - startedAt,
    });
    return this.catalog;
  }

  private score(task: string, model: GatewayModelInfo): number {
    const taskStats = this.stats.get(task)?.get(model.id);
    const transportAttempts = taskStats?.transportAttempts ?? 0;
    const transportSuccesses = taskStats?.transportSuccesses ?? 0;
    const validatedSuccesses = taskStats?.validatedSuccesses ?? 0;
    const failures = taskStats?.failures ?? 0;
    const averageLatency =
      taskStats && transportAttempts > 0 ? taskStats.totalLatencyMs / transportAttempts : 0;
    const crossLensValidatedSuccesses = task.startsWith("review_")
      ? (this.validatedReviewSuccesses.get(model.id) ?? 0)
      : 0;

    const learnedScore =
      validatedSuccesses * 4_000 +
      crossLensValidatedSuccesses * 5_000 +
      transportSuccesses * 200 -
      failures * 5_000 -
      averageLatency / 20;
    const contextLength = modelContextLength(model);
    const contextScore = contextLength <= 0 ? 0 : (Math.min(contextLength, 131_072) / 131_072) * 30;
    const speedScore = task.startsWith("review_") ? reviewSpeedScore(model) : 0;
    const taskAffinity = (stableHash(task + "|" + model.id) % 10_000) / 10_000;
    return learnedScore + contextScore + speedScore + taskAffinity;
  }

  private feedbackModels(model: string, responseModel?: string): Set<string> {
    const candidates = new Set<string>([model]);
    const normalizedResponseModel = responseModel?.trim();
    if (normalizedResponseModel && this.catalog) {
      const alias = this.catalog.find(
        (entry) =>
          entry.id === normalizedResponseModel ||
          entry.id.replace(/:free$/, "") === normalizedResponseModel.replace(/:free$/, ""),
      )?.id;
      if (alias) candidates.add(alias);
    }
    return candidates;
  }

  private excludeForTask(task: string, model: string, reason: string): void {
    let excluded = this.taskExcludedModels.get(task);
    if (!excluded) {
      excluded = new Set<string>();
      this.taskExcludedModels.set(task, excluded);
    }
    excluded.add(model);

    if (/daily limit|limit_rpd|per day|rpd/i.test(reason)) {
      this.globallyUnhealthyUntil.set(
        model,
        Date.now() + cooldownForFailure(reason, this.modelCooldownMs),
      );
      return;
    }

    let unhealthy = this.taskUnhealthyUntil.get(task);
    if (!unhealthy) {
      unhealthy = new Map<string, number>();
      this.taskUnhealthyUntil.set(task, unhealthy);
    }
    unhealthy.set(model, Date.now() + cooldownForFailure(reason, this.modelCooldownMs));
  }

  private clearTaskFailure(task: string, model: string): void {
    this.taskUnhealthyUntil.get(task)?.delete(model);
  }

  private currentStats(task: string, model: string): ModelStats {
    let taskStats = this.stats.get(task);
    if (!taskStats) {
      taskStats = new Map<string, ModelStats>();
      this.stats.set(task, taskStats);
    }

    const current = taskStats.get(model) ?? {
      transportAttempts: 0,
      transportSuccesses: 0,
      validatedSuccesses: 0,
      failures: 0,
      totalLatencyMs: 0,
    };
    taskStats.set(model, current);
    return current;
  }

  private recordTransport(task: string, model: string, success: boolean, latencyMs: number): void {
    const current = this.currentStats(task, model);
    current.transportAttempts += 1;
    current.transportSuccesses += success ? 1 : 0;
    current.failures += success ? 0 : 1;
    current.totalLatencyMs += latencyMs;
  }

  private recordSemanticFailure(task: string, model: string): void {
    const current = this.currentStats(task, model);
    current.failures += 1;
  }

  private recordValidatedSuccess(task: string, model: string): void {
    const current = this.currentStats(task, model);
    current.validatedSuccesses += 1;
    if (task.startsWith("review_")) {
      this.validatedReviewSuccesses.set(
        model,
        (this.validatedReviewSuccesses.get(model) ?? 0) + 1,
      );
    }
  }

}
