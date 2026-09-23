import {
  KiloGatewayClient,
  type GatewayChatClient,
  type GatewayModelFailureFeedback,
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
  successes: number;
  failures: number;
  totalLatencyMs: number;
}

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

function reviewSpeedScore(modelId: string): number {
  const id = modelId.toLowerCase();
  let score = 0;
  if (/flash|lightning|fast/.test(id)) score += 120;
  if (/mini|small|lite|\bxs\b/.test(id)) score += 80;
  if (/ultra|max|550b/.test(id)) score -= 160;
  if (/large|120b/.test(id)) score -= 80;
  if (/vl|vision/.test(id)) score -= 40;
  return score;
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
  private readonly unhealthyUntil = new Map<string, number>();
  private readonly sessionExcludedModels = new Set<string>();
  private readonly blockedProviders = new Set<string>();

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
    const responseModel = feedback.responseModel?.trim();
    const candidates = new Set<string>([model]);
    if (responseModel && this.catalog) {
      const alias = this.catalog.find(
        (entry) =>
          entry.id === responseModel ||
          entry.id.replace(/:free$/, "") === responseModel.replace(/:free$/, ""),
      )?.id;
      if (alias) candidates.add(alias);
    }

    for (const candidate of candidates) {
      this.record(task, candidate, false, 0);
      if (candidate !== "kilo-auto/free" && isFreeModelId(candidate)) {
        this.sessionExcludedModels.add(candidate);
        this.unhealthyUntil.set(
          candidate,
          Date.now() + cooldownForFailure(feedback.reason, this.modelCooldownMs),
        );
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
      await this.onRoute?.({
        type: "attempt",
        task,
        candidateModel,
        attempt,
        maxAttempts: candidates.length,
      });

      const startedAt = Date.now();
      try {
        const response = await this.client.createChatCompletion({
          ...request,
          model: candidateModel,
        });
        const latencyMs = Date.now() - startedAt;
        this.record(task, candidateModel, true, latencyMs);
        this.unhealthyUntil.delete(candidateModel);
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
        this.record(task, candidateModel, false, latencyMs);
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
        if (candidateModel !== "kilo-auto/free") {
          this.sessionExcludedModels.add(candidateModel);
          this.unhealthyUntil.set(
            candidateModel,
            Date.now() + cooldownForFailure(reason, this.modelCooldownMs),
          );
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

    if (
      requested !== "kilo-auto/free" &&
      !avoided.has(requested) &&
      !this.sessionExcludedModels.has(requested) &&
      !this.blockedProviders.has(providerKey(requested))
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
            !this.sessionExcludedModels.has(model.id) &&
            !this.blockedProviders.has(providerKey(model)) &&
            (this.unhealthyUntil.get(model.id) ?? 0) <= now,
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
      // Live discovery is an optimization. Preserve the configured Auto Free fallback.
    }

    const autoFreeAllowed = !avoided.has("kilo-auto/free");
    if (autoFreeAllowed && !candidates.includes("kilo-auto/free")) {
      candidates.push("kilo-auto/free");
    }

    if (candidates.length === 0) candidates.push(requested);

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
    const successes = taskStats?.successes ?? 0;
    const failures = taskStats?.failures ?? 0;
    const averageLatency =
      taskStats && taskStats.successes + taskStats.failures > 0
        ? taskStats.totalLatencyMs / (taskStats.successes + taskStats.failures)
        : 0;

    const learnedScore = successes * 4_000 - failures * 5_000 - averageLatency / 20;
    const contextLength = modelContextLength(model);
    const contextScore = contextLength <= 0 ? 0 : (Math.min(contextLength, 131_072) / 131_072) * 30;
    const speedScore = task.startsWith("review_") ? reviewSpeedScore(model.id) : 0;
    const taskAffinity = (stableHash(task + "|" + model.id) % 10_000) / 10_000;
    return learnedScore + contextScore + speedScore + taskAffinity;
  }

  private record(task: string, model: string, success: boolean, latencyMs: number): void {
    let taskStats = this.stats.get(task);
    if (!taskStats) {
      taskStats = new Map<string, ModelStats>();
      this.stats.set(task, taskStats);
    }

    const current = taskStats.get(model) ?? {
      successes: 0,
      failures: 0,
      totalLatencyMs: 0,
    };
    taskStats.set(model, {
      successes: current.successes + (success ? 1 : 0),
      failures: current.failures + (success ? 0 : 1),
      totalLatencyMs: current.totalLatencyMs + latencyMs,
    });
  }
}
