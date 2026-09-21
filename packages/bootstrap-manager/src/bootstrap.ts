import { access, readdir } from "node:fs/promises";
import { extname, resolve } from "node:path";
import type { AgentConfig } from "@llmatic/core";
import { detectRepository } from "@llmatic/core";
import {
  DEFAULT_TOOL_REGISTRY,
  detectRegisteredTools,
  installRegisteredTool,
  type ToolDetection,
  type ToolId,
} from "@llmatic/tool-registry";
import type {
  BootstrapRemediationOptions,
  BootstrapRemediationResult,
  BootstrapReport,
  BootstrapRequirement,
  BootstrapRequirementLevel,
} from "./types.js";

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function containsPython(root: string): Promise<boolean> {
  for (const marker of ["pyproject.toml", "requirements.txt", "uv.lock", "Pipfile"]) {
    if (await exists(resolve(root, marker))) return true;
  }

  for (const directoryName of ["scripts", "src", "tools"]) {
    const directory = resolve(root, directoryName);
    try {
      const entries = await readdir(directory, { withFileTypes: true });
      if (entries.some((entry) => entry.isFile() && extname(entry.name).toLowerCase() === ".py")) {
        return true;
      }
    } catch {
      // Missing conventional source directories are normal.
    }
  }

  return false;
}

async function repositorySignals(root: string) {
  const docker =
    (await exists(resolve(root, "Dockerfile"))) ||
    (await exists(resolve(root, "docker-compose.yml"))) ||
    (await exists(resolve(root, "docker-compose.yaml"))) ||
    (await exists(resolve(root, "compose.yml"))) ||
    (await exists(resolve(root, "compose.yaml")));

  const supabase = await exists(resolve(root, "supabase", "config.toml"));
  const deno =
    (await exists(resolve(root, "deno.json"))) || (await exists(resolve(root, "deno.jsonc")));
  const python = await containsPython(root);

  return { docker, supabase, deno, python };
}

function statusMap(statuses: ToolDetection[]): Map<ToolId, ToolDetection> {
  return new Map(statuses.map((status) => [status.id, status]));
}

function requirement(
  statuses: Map<ToolId, ToolDetection>,
  id: ToolId,
  level: BootstrapRequirementLevel,
  reason: string,
): BootstrapRequirement {
  const status = statuses.get(id);
  if (!status) throw new Error("Bootstrap tool " + id + " is not registered.");

  return {
    id,
    name: status.name,
    level,
    reason,
    installed: status.installed,
    version: status.version,
    installerAvailable: status.installerAvailable,
  };
}

export async function inspectBootstrap(
  root: string,
  _config: AgentConfig,
): Promise<BootstrapReport> {
  const detection = await detectRepository(root);
  const statuses = statusMap(await detectRegisteredTools(detection.root, DEFAULT_TOOL_REGISTRY));
  const signals = await repositorySignals(detection.root);
  const requirements: BootstrapRequirement[] = [
    requirement(statuses, "node", "required", "Required to launch the bundled MCP runtime."),
    requirement(statuses, "git", "required", "Required for repository workflow operations."),
    requirement(
      statuses,
      "github-cli",
      "recommended",
      "Required when using GitHub PR, remote-CI, and merge workflow stages.",
    ),
  ];

  let unsupportedPackageManager: string | undefined;

  if (detection.packageManager === "pnpm") {
    requirements.push(
      requirement(statuses, "pnpm", "required", "Repository declares pnpm as its package manager."),
    );
  } else if (detection.packageManager === "yarn" || detection.packageManager === "bun") {
    unsupportedPackageManager =
      detection.packageManager +
      " is detected, but M13 bootstrap does not yet register an automated installer for it.";
  }

  if (signals.docker) {
    requirements.push(
      requirement(statuses, "docker", "recommended", "Docker/Compose project files were detected."),
    );
  }

  if (signals.supabase) {
    requirements.push(
      requirement(statuses, "supabase", "recommended", "supabase/config.toml was detected."),
    );
    if (!signals.docker) {
      requirements.push(
        requirement(statuses, "docker", "recommended", "Supabase local development uses Docker."),
      );
    }
  }

  if (signals.deno) {
    requirements.push(
      requirement(statuses, "deno", "recommended", "Deno project configuration was detected."),
    );
  }

  if (signals.python) {
    requirements.push(
      requirement(statuses, "python", "recommended", "Python project/source files were detected."),
    );
    requirements.push(
      requirement(statuses, "uv", "optional", "Preferred fast Python environment/runtime manager."),
    );
  }

  requirements.push(
    requirement(
      statuses,
      "ollama",
      "optional",
      "Optional local-LLM runtime for offline/private model execution.",
    ),
  );

  const deduplicated = Array.from(new Map(requirements.map((item) => [item.id, item])).values());

  return {
    root: detection.root,
    ready: !deduplicated.some((item) => item.level === "required" && !item.installed),
    requirements: deduplicated,
    unsupportedPackageManager,
  };
}

export async function remediateBootstrap(
  root: string,
  config: AgentConfig,
  toolIds: readonly ToolId[],
  options: BootstrapRemediationOptions = {},
): Promise<BootstrapRemediationResult> {
  const uniqueIds = Array.from(new Set(toolIds));
  const installations: ToolInstallResult[] = [];

  for (const id of uniqueIds) {
    installations.push(
      await installRegisteredTool(root, config, id, {
        approved: options.approved ?? false,
      }),
    );
  }

  return {
    report: await inspectBootstrap(root, config),
    installations,
  };
}
