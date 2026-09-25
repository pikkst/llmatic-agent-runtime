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
      type: "review-history";
      task: string;
      trustedModels: string[];
      mixedModels: string[];
      explorationModels: string[];
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

export interface ReviewModelHistoryRecord {
  model: string;
  task: string;
  validatedReports: number;
  semanticFailures: number;
  lengthFailures: number;
  transportFailures: number;
  lastValidatedAt?: number;
  updatedAt: number;
}

export interface AdaptiveFreeGatewayClientOptions extends KiloGatewayClientOptions {
  maxModelAttempts?: number;
  catalogTtlMs?: number;
  modelCooldownMs?: number;
  reviewHistory?: ReviewModelHistoryRecord[];
  reviewHistoryMaxAgeMs?: number;
  reviewExplorationSlots?: number;
  onReviewHistoryChange?: (history: ReviewModelHistoryRecord[]) => void | Promise<void>;
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
const REVIEW_FAILURE_COOLDOWN_MS = 15 * 60_000;

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
      for (const token of value
        .toLowerCase()
        .split(/[^a-z0-9_]+/)
        .filter(Boolean)) {
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
      for (const token of value
        .toLowerCase()
        .split(/[^a-z0-9_]+/)
        .filter(Boolean)) {
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
  const identity = (model.id + " " + (model.name ?? "")).toLowerCase();
  if (/reasoning|thinking|(?:^|[\/_-])r1(?:[\/_:-]|$)|\bqwq\b/.test(identity)) return true;

  // Generic catalog capabilities such as "reasoning" mean the model can support
  // reasoning controls; they do not mean every request uses a slow reasoning-heavy
  // path. Only explicit dedicated-model metadata should trigger this penalty.
  const source = model as Record<string, unknown>;
  return [
    source.reasoning_model,
    source.reasoningModel,
    source.thinking_model,
    source.thinkingModel,
    source.reasoning_only,
    source.reasoningOnly,
  ].some((value) => value === true);
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

function reviewStructuredOutputScore(
  model: GatewayModelInfo,
  request: GatewayChatRequest,
  task: string,
): number {
  if (!task.startsWith("review_") || !request.response_format) return 0;

  const support = structuredOutputSupport(model);
  if (support === "supported") return 900;
  if (support === "unsupported") return -300;
  return 0;
}

function autoFreeCircuitBreakerFailure(reason: string): boolean {
  return /timed? out|timeout|temporar|overload|resourceexhausted|resource exhausted|upstream.*unavailable|service.*unavailable/i.test(
    reason,
  );
}

function cooldownForFailure(reason: string, fallbackMs: number): number {
  if (/daily limit|limit_rpd|per day|rpd/i.test(reason)) return 24 * 60 * 60_000;
  if (/rate.?limit|too many requests|\b429\b/i.test(reason)) {
    return Math.max(30_000, Math.min(fallbackMs, 60_000));
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
  private readonly onReviewHistoryChange?: (
    history: ReviewModelHistoryRecord[],
  ) => void | Promise<void>;
  private readonly reviewHistoryMaxAgeMs: number;
  private readonly reviewExplorationSlots: number;
  private readonly reviewHistory = new Map<string, ReviewModelHistoryRecord>();
  private catalog?: GatewayModelInfo[];
  private catalogExpiresAt = 0;
  private readonly stats = new Map<string, Map<string, ModelStats>>();
  private readonly validatedReviewSuccesses = new Map<string, number>();
  private readonly reviewSemanticFailures = new Map<string, number>();
  private readonly reviewTransportFailures = new Map<string, number>();
  private readonly reviewLengthFailures = new Map<string, number>();
  private readonly reviewFamilyExcludedModels = new Set<string>();
  private readonly taskUnhealthyUntil = new Map<string, Map<string, number>>();
  private readonly globallyUnhealthyUntil = new Map<string, number>();
  private readonly taskExcludedModels = new Map<string, Set<string>>();
  private readonly blockedProviders = new Set<string>();
  private readonly autoFreeTaskFailures = new Map<string, number>();
  private readonly autoFreeDisabledTasks = new Set<string>();

  public constructor(options: AdaptiveFreeGatewayClientOptions) {
    this.client = new KiloGatewayClient(options);
    this.maxModelAttempts = Math.max(1, Math.min(8, Math.trunc(options.maxModelAttempts ?? 4)));
    this.catalogTtlMs = Math.max(30_000, Math.trunc(options.catalogTtlMs ?? 5 * 60_000));
    this.modelCooldownMs = Math.max(30_000, Math.trunc(options.modelCooldownMs ?? 5 * 60_000));
    this.reviewHistoryMaxAgeMs = Math.max(
      60_000,
      Math.trunc(options.reviewHistoryMaxAgeMs ?? 7 * 24 * 60 * 60_000),
    );
    this.reviewExplorationSlots = Math.max(
      0,
      Math.min(2, Math.trunc(options.reviewExplorationSlots ?? 1)),
    );
    this.onReviewHistoryChange = options.onReviewHistoryChange;
    this.onRoute = options.onRoute;

    for (const record of options.reviewHistory ?? []) {
      if (!record.model?.trim() || !record.task?.trim()) continue;
      this.reviewHistory.set(this.reviewHistoryKey(record.model, record.task), {
        ...record,
        model: record.model.trim(),
        task: record.task.trim(),
      });
    }
  }

  public async reportModelFailure(feedback: GatewayModelFailureFeedback): Promise<void> {
    const model = feedback.model.trim();
    if (!model) return;

    const task = feedback.task?.trim() || "generic";
    const capacityFailure =
      /generation length limit reached without structured review content/i.test(feedback.reason);
    for (const candidate of this.feedbackModels(model, feedback.responseModel)) {
      this.recordSemanticFailure(task, candidate);
      if (task.startsWith("review_") && !capacityFailure) {
        this.excludeForTask(task, candidate, feedback.reason);
      }
      if (
        task.startsWith("review_") &&
        /generation length limit reached without structured review content/i.test(feedback.reason)
      ) {
        const failures = (this.reviewLengthFailures.get(candidate) ?? 0) + 1;
        this.reviewLengthFailures.set(candidate, failures);
        const history = this.reviewHistoryRecord(candidate, task);
        history.lengthFailures += 1;
        history.updatedAt = Date.now();
        this.excludeFromReviewFamilyAfterRepeatedFailure(candidate, failures);
      }
    }

    if (task.startsWith("review_")) {
      await this.persistReviewHistory();
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

    if (task.startsWith("review_")) {
      await this.persistReviewHistory();
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
        if (candidateModel === "kilo-auto/free") {
          this.autoFreeTaskFailures.delete(task);
          this.autoFreeDisabledTasks.delete(task);
        }
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
        if (task.startsWith("review_")) {
          await this.persistReviewHistory();
        }
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
            const failures = (this.autoFreeTaskFailures.get(task) ?? 0) + 1;
            this.autoFreeTaskFailures.set(task, failures);
            if (failures >= AUTO_FREE_SESSION_FAILURE_LIMIT) {
              this.autoFreeDisabledTasks.add(task);
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
      !(task.startsWith("review_") && this.reviewFamilyExcludedModels.has(requested)) &&
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
            !(task.startsWith("review_") && this.reviewFamilyExcludedModels.has(model.id)) &&
            !(
              task.startsWith("review_") &&
              /content.?safety|moderation|guard/.test(model.id.toLowerCase())
            ) &&
            !this.blockedProviders.has(providerKey(model)) &&
            (taskUnhealthy?.get(model.id) ?? 0) <= now &&
            (this.globallyUnhealthyUntil.get(model.id) ?? 0) <= now,
        )
        .sort(
          (left, right) =>
            this.score(task, right) +
            reviewStructuredOutputScore(right, request, task) -
            (this.score(task, left) + reviewStructuredOutputScore(left, request, task)),
        );

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

      const orderedModels = [...diverse, ...remainder];
      const trustedModels = task.startsWith("review_")
        ? orderedModels.filter((model) => this.reviewModelTier(model.id, task) === "trusted")
        : [];
      const mixedModels = task.startsWith("review_")
        ? orderedModels.filter((model) => this.reviewModelTier(model.id, task) === "mixed")
        : [];
      const knownModels = new Set([
        ...trustedModels.map((model) => model.id),
        ...mixedModels.map((model) => model.id),
      ]);
      const explorationModels = task.startsWith("review_")
        ? orderedModels
            .filter((model) => !knownModels.has(model.id))
            .slice(0, this.reviewExplorationSlots)
        : [];

      if (task.startsWith("review_")) {
        await this.onRoute?.({
          type: "review-history",
          task,
          trustedModels: trustedModels.map((model) => model.id),
          mixedModels: mixedModels.map((model) => model.id),
          explorationModels: explorationModels.map((model) => model.id),
        });
      }

      const selectedModels = task.startsWith("review_")
        ? [...trustedModels, ...mixedModels, ...explorationModels]
        : orderedModels;

      for (const model of selectedModels) {
        if (!candidates.includes(model.id)) candidates.push(model.id);
      }
    } catch {
      // Live discovery is an optimization. Preserve Auto Free only while its circuit is closed.
    }

    const reviewTask = task.startsWith("review_");
    const autoFreeDisabled = this.autoFreeDisabledTasks.has(task);
    const autoFreeAllowed = !avoided.has("kilo-auto/free") && !autoFreeDisabled;
    const explicitCandidateCount = candidates.filter((model) => model !== "kilo-auto/free").length;
    const autoFreeNeeded =
      autoFreeAllowed && (!reviewTask || explicitCandidateCount < this.maxModelAttempts);

    if (autoFreeNeeded && !candidates.includes("kilo-auto/free")) {
      candidates.push("kilo-auto/free");
    }

    if (candidates.length === 0) {
      throw new Error(
        "No compatible free-model candidates remain for " +
          task +
          (autoFreeDisabled ? " (Auto Free circuit breaker open)." : "."),
      );
    }

    if (this.maxModelAttempts === 1) {
      return [candidates[0]!];
    }

    if (reviewTask) {
      return candidates.slice(0, this.maxModelAttempts);
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
    const crossLensSemanticFailures = task.startsWith("review_")
      ? (this.reviewSemanticFailures.get(model.id) ?? 0)
      : 0;
    const crossLensTransportFailures = task.startsWith("review_")
      ? (this.reviewTransportFailures.get(model.id) ?? 0)
      : 0;
    const persistentReviewScore = task.startsWith("review_")
      ? this.persistentReviewScore(model.id, task)
      : 0;

    const learnedScore =
      validatedSuccesses * 4_000 +
      Math.min(crossLensValidatedSuccesses, 2) * 5_000 +
      transportSuccesses * 200 -
      failures * 5_000 -
      crossLensSemanticFailures * 2_500 -
      crossLensTransportFailures * 2_000 -
      averageLatency / 20 +
      persistentReviewScore;
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
    if (providerCompatibilityFailure(reason)) {
      let excluded = this.taskExcludedModels.get(task);
      if (!excluded) {
        excluded = new Set<string>();
        this.taskExcludedModels.set(task, excluded);
      }
      excluded.add(model);
    }

    if (/daily limit|limit_rpd|per day|rpd/i.test(reason)) {
      this.globallyUnhealthyUntil.set(
        model,
        Date.now() + cooldownForFailure(reason, this.modelCooldownMs),
      );
      return;
    }

    const cooldownMs = task.startsWith("review_")
      ? Math.max(this.modelCooldownMs, REVIEW_FAILURE_COOLDOWN_MS)
      : this.modelCooldownMs;

    let unhealthy = this.taskUnhealthyUntil.get(task);
    if (!unhealthy) {
      unhealthy = new Map<string, number>();
      this.taskUnhealthyUntil.set(task, unhealthy);
    }
    unhealthy.set(
      model,
      Date.now() +
        (/rate.?limit|too many requests|\b429\b/i.test(reason)
          ? cooldownMs
          : cooldownForFailure(reason, cooldownMs)),
    );
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
    if (!success && task.startsWith("review_")) {
      const failures = (this.reviewTransportFailures.get(model) ?? 0) + 1;
      this.reviewTransportFailures.set(model, failures);
      const history = this.reviewHistoryRecord(model, task);
      history.transportFailures += 1;
      history.updatedAt = Date.now();
    }
  }

  private excludeFromReviewFamilyAfterRepeatedFailure(model: string, failures: number): void {
    if (model === "kilo-auto/free" || failures < 2) return;
    if ((this.validatedReviewSuccesses.get(model) ?? 0) > 0) return;
    this.reviewFamilyExcludedModels.add(model);
  }

  private recordSemanticFailure(task: string, model: string): void {
    const current = this.currentStats(task, model);
    current.failures += 1;
    if (task.startsWith("review_")) {
      this.reviewSemanticFailures.set(model, (this.reviewSemanticFailures.get(model) ?? 0) + 1);
      const history = this.reviewHistoryRecord(model, task);
      history.semanticFailures += 1;
      history.updatedAt = Date.now();
    }
  }

  private recordValidatedSuccess(task: string, model: string): void {
    const current = this.currentStats(task, model);
    current.validatedSuccesses += 1;
    if (task.startsWith("review_")) {
      this.validatedReviewSuccesses.set(model, (this.validatedReviewSuccesses.get(model) ?? 0) + 1);
      this.reviewFamilyExcludedModels.delete(model);
      const history = this.reviewHistoryRecord(model, task);
      history.validatedReports += 1;
      history.lastValidatedAt = Date.now();
      history.updatedAt = history.lastValidatedAt;
    }
  }

  private reviewHistoryKey(model: string, task: string): string {
    return task + "\u0000" + model;
  }

  private reviewHistoryRecord(model: string, task: string): ReviewModelHistoryRecord {
    const key = this.reviewHistoryKey(model, task);
    const existing = this.reviewHistory.get(key);
    if (existing) return existing;

    const created: ReviewModelHistoryRecord = {
      model,
      task,
      validatedReports: 0,
      semanticFailures: 0,
      lengthFailures: 0,
      transportFailures: 0,
      updatedAt: Date.now(),
    };
    this.reviewHistory.set(key, created);
    return created;
  }

  private freshReviewHistory(model: string): ReviewModelHistoryRecord[] {
    const cutoff = Date.now() - this.reviewHistoryMaxAgeMs;
    return [...this.reviewHistory.values()].filter(
      (record) => record.model === model && (record.lastValidatedAt ?? record.updatedAt) >= cutoff,
    );
  }

  private reviewModelTier(model: string, task: string): "trusted" | "mixed" | "unproven" {
    const records = this.freshReviewHistory(model);
    if (records.length === 0) return "unproven";

    const exact = records.find((record) => record.task === task);
    const exactValidated = exact?.validatedReports ?? 0;
    const exactSemanticFailures = exact?.semanticFailures ?? 0;
    const exactLengthFailures = exact?.lengthFailures ?? 0;
    const exactTransportFailures = exact?.transportFailures ?? 0;
    const exactAttempts = exactValidated + exactSemanticFailures + exactTransportFailures;
    const exactValidatedRate = exactAttempts > 0 ? exactValidated / exactAttempts : 0;
    const exactLengthFailureRate = exactAttempts > 0 ? exactLengthFailures / exactAttempts : 0;

    if (exactValidated >= 2 && exactValidatedRate >= 0.5 && exactLengthFailureRate < 0.35) {
      return "trusted";
    }

    const totalValidated = records.reduce((total, record) => total + record.validatedReports, 0);
    return totalValidated >= 1 ? "mixed" : "unproven";
  }

  private persistentReviewScore(model: string, task: string): number {
    const records = this.freshReviewHistory(model);
    if (records.length === 0) return 0;

    const exact = records.find((record) => record.task === task);
    const totalValidated = records.reduce((total, record) => total + record.validatedReports, 0);
    const totalSemanticFailures = records.reduce(
      (total, record) => total + record.semanticFailures,
      0,
    );
    const totalLengthFailures = records.reduce((total, record) => total + record.lengthFailures, 0);
    const totalTransportFailures = records.reduce(
      (total, record) => total + record.transportFailures,
      0,
    );

    return (
      (exact?.validatedReports ?? 0) * 10_000 +
      Math.min(totalValidated, 6) * 4_000 -
      totalLengthFailures * 2_500 -
      totalSemanticFailures * 1_000 -
      totalTransportFailures * 300
    );
  }

  private async persistReviewHistory(): Promise<void> {
    if (!this.onReviewHistoryChange) return;
    await this.onReviewHistoryChange(
      [...this.reviewHistory.values()]
        .map((record) => ({ ...record }))
        .sort((left, right) =>
          left.model === right.model
            ? left.task.localeCompare(right.task)
            : left.model.localeCompare(right.model),
        ),
    );
  }
}
