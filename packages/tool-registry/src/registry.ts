import { spawnSync } from "node:child_process";
import type { AgentConfig } from "@llmatic/core";
import {
  TOOL_IDS,
  type StructuredToolCommand,
  type ToolDefinition,
  type ToolDetection,
  type ToolId,
  type ToolInstallResult,
  type ToolProcessResult,
  type ToolProcessRunner,
} from "./types.js";

const PNPM_VERSION = "10.17.1";

export const DEFAULT_TOOL_REGISTRY: readonly ToolDefinition[] = [
  {
    id: "node",
    name: "Node.js",
    baseline: true,
    probes: [{ executable: "node", args: ["--version"] }],
  },
  {
    id: "git",
    name: "Git",
    baseline: true,
    probes: [{ executable: "git", args: ["--version"] }],
  },
  {
    id: "pnpm",
    name: "pnpm",
    baseline: false,
    probes: [{ executable: "pnpm", args: ["--version"] }],
    installer: {
      description: "Activate the runtime-pinned pnpm version through Corepack.",
      steps: [
        { executable: "corepack", args: ["enable"] },
        {
          executable: "corepack",
          args: ["prepare", "pnpm@" + PNPM_VERSION, "--activate"],
        },
      ],
    },
  },
  {
    id: "docker",
    name: "Docker",
    baseline: false,
    probes: [{ executable: "docker", args: ["--version"] }],
  },
  {
    id: "github-cli",
    name: "GitHub CLI",
    baseline: false,
    probes: [{ executable: "gh", args: ["--version"] }],
  },
  {
    id: "deno",
    name: "Deno",
    baseline: false,
    probes: [{ executable: "deno", args: ["--version"] }],
  },
  {
    id: "supabase",
    name: "Supabase CLI",
    baseline: false,
    probes: [{ executable: "supabase", args: ["--version"] }],
  },
  {
    id: "python",
    name: "Python",
    baseline: false,
    probes: [
      { executable: "python", args: ["--version"] },
      { executable: "python3", args: ["--version"] },
    ],
  },
  {
    id: "uv",
    name: "uv",
    baseline: false,
    probes: [{ executable: "uv", args: ["--version"] }],
  },
  {
    id: "ollama",
    name: "Ollama",
    baseline: false,
    probes: [{ executable: "ollama", args: ["--version"] }],
  },
];

export interface ToolOperationOptions {
  approved?: boolean;
  runner?: ToolProcessRunner;
}

function defaultRunner(executable: string, args: string[], cwd: string): ToolProcessResult {
  const result = spawnSync(executable, args, {
    cwd,
    env: process.env,
    encoding: "utf8",
    shell: process.platform === "win32",
  });

  if (result.error) {
    return {
      exitCode: 127,
      stdout: "",
      stderr: result.error.message,
    };
  }

  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function firstOutputLine(result: ToolProcessResult): string | undefined {
  const output = [result.stdout, result.stderr]
    .join("\n")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);

  return output || undefined;
}

function definitionFor(
  id: ToolId,
  registry: readonly ToolDefinition[],
): ToolDefinition {
  const definition = registry.find((candidate) => candidate.id === id);

  if (!definition) {
    throw new Error("Tool " + id + " is not registered.");
  }

  return definition;
}

export function parseToolId(input: string): ToolId {
  if (!TOOL_IDS.includes(input as ToolId)) {
    throw new Error(
      "Unknown tool: " + input + ". Registered tools: " + TOOL_IDS.join(", ") + ".",
    );
  }

  return input as ToolId;
}

export async function detectTool(
  root: string,
  definition: ToolDefinition,
  runner: ToolProcessRunner = defaultRunner,
): Promise<ToolDetection> {
  for (const probe of definition.probes) {
    const result = runner(probe.executable, probe.args, root);

    if (result.exitCode === 0) {
      return {
        id: definition.id,
        name: definition.name,
        baseline: definition.baseline,
        installed: true,
        version: firstOutputLine(result),
        executable: probe.executable,
        installerAvailable: Boolean(definition.installer),
      };
    }
  }

  return {
    id: definition.id,
    name: definition.name,
    baseline: definition.baseline,
    installed: false,
    installerAvailable: Boolean(definition.installer),
  };
}

export async function detectRegisteredTools(
  root: string,
  registry: readonly ToolDefinition[] = DEFAULT_TOOL_REGISTRY,
  runner: ToolProcessRunner = defaultRunner,
): Promise<ToolDetection[]> {
  const statuses: ToolDetection[] = [];

  for (const definition of registry) {
    statuses.push(await detectTool(root, definition, runner));
  }

  return statuses;
}

function assertInstallPermission(config: AgentConfig, approved: boolean): void {
  const permission = config.permissions.installTools;

  if (permission === "deny") {
    throw new Error("Tool installation is denied by llmatic.agent.yaml.");
  }

  if (permission === "ask" && !approved) {
    throw new Error(
      "Tool installation requires approval. Re-run with --approve after reviewing the installer.",
    );
  }
}

function displayCommand(command: StructuredToolCommand): string {
  return [command.executable, ...command.args].join(" ");
}

export async function installRegisteredTool(
  root: string,
  config: AgentConfig,
  id: ToolId,
  options: ToolOperationOptions = {},
  registry: readonly ToolDefinition[] = DEFAULT_TOOL_REGISTRY,
): Promise<ToolInstallResult> {
  const definition = definitionFor(id, registry);
  const runner = options.runner ?? defaultRunner;
  const existing = await detectTool(root, definition, runner);

  if (existing.installed) {
    return {
      changed: false,
      tool: existing,
      executedSteps: 0,
    };
  }

  assertInstallPermission(config, options.approved ?? false);

  if (!definition.installer) {
    throw new Error(
      "No automated installer is registered for " +
        definition.name +
        ". Install it manually or add a platform-specific tool pack.",
    );
  }

  let executedSteps = 0;

  for (const step of definition.installer.steps) {
    const result = runner(step.executable, step.args, root);
    executedSteps += 1;

    if (result.exitCode !== 0) {
      throw new Error(
        "Tool installer failed: " +
          displayCommand(step) +
          ". Exit code: " +
          result.exitCode +
          ".",
      );
    }
  }

  const installed = await detectTool(root, definition, runner);

  if (!installed.installed) {
    throw new Error(
      "Installer completed but " + definition.name + " is still not detectable on PATH.",
    );
  }

  return {
    changed: true,
    tool: installed,
    executedSteps,
  };
}
