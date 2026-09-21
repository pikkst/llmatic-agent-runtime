import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import type { AgentConfig } from "./config.js";
import { detectRepository } from "./detect.js";
import type {
  Capability,
  CapabilityExecutionResult,
  CapabilityName,
  RepositoryDetection,
} from "./types.js";

export interface ProcessExecution {
  exitCode: number;
}

export type CapabilityProcessRunner = (
  executable: string,
  args: string[],
  cwd: string,
) => ProcessExecution;

export interface ExecuteCapabilityOptions {
  approved?: boolean;
  runner?: CapabilityProcessRunner;
}

function defaultRunner(executable: string, args: string[], cwd: string): ProcessExecution {
  const result = spawnSync(executable, args, {
    cwd,
    env: process.env,
    stdio: "inherit",
    shell: process.platform === "win32",
  });

  if (result.error) {
    throw result.error;
  }

  return {
    exitCode: result.status ?? 1,
  };
}

function assertPermission(config: AgentConfig, capability: CapabilityName, approved: boolean): void {
  const permission =
    capability === "test" ? config.permissions.runTests : config.permissions.runQualityGates;

  if (permission === "deny") {
    throw new Error("Capability " + capability + " is denied by llmatic.agent.yaml.");
  }

  if (permission === "ask" && !approved) {
    throw new Error(
      "Capability " + capability + " requires approval. Re-run with --approve after reviewing it.",
    );
  }
}

export function resolveCapability(
  detection: RepositoryDetection,
  name: CapabilityName,
): Capability {
  const capability = detection.capabilities.find((candidate) => candidate.name === name);

  if (!capability?.available || !capability.executable || !capability.args || !capability.command) {
    throw new Error("Capability " + name + " is not available in this repository.");
  }

  return capability;
}

export async function executeCapability(
  root: string,
  config: AgentConfig,
  name: CapabilityName,
  options: ExecuteCapabilityOptions = {},
): Promise<CapabilityExecutionResult> {
  assertPermission(config, name, options.approved ?? false);

  const detection = await detectRepository(root);
  const capability = resolveCapability(detection, name);
  const runner = options.runner ?? defaultRunner;
  const startedAt = new Date().toISOString();
  const started = performance.now();

  const execution = runner(capability.executable!, capability.args!, root);

  const durationMs = Math.round(performance.now() - started);
  const finishedAt = new Date().toISOString();

  return {
    capability: name,
    command: capability.command!,
    startedAt,
    finishedAt,
    durationMs,
    exitCode: execution.exitCode,
    success: execution.exitCode === 0,
  };
}
