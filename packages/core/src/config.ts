import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { parse, stringify } from "yaml";
import { z } from "zod";
import type { RepositoryDetection } from "./types.js";

const permissionSchema = z.enum(["auto", "ask", "deny"]);

export const agentConfigSchema = z.object({
  version: z.literal(1),
  project: z.object({
    name: z.string().min(1),
  }),
  runtime: z.object({
    stateDirectory: z.string().min(1),
    cacheDirectory: z.string().min(1),
  }),
  permissions: z.object({
    repositoryRead: permissionSchema,
    repositoryWrite: permissionSchema,
    taskRead: permissionSchema.default("auto"),
    taskWrite: permissionSchema.default("ask"),
    localProcess: permissionSchema.default("ask"),
    runTests: permissionSchema,
    runQualityGates: permissionSchema.default("auto"),
    docker: permissionSchema,
    installTools: permissionSchema,
    gitPush: permissionSchema,
    createPullRequest: permissionSchema,
    mergePullRequest: permissionSchema,
    databaseMigration: permissionSchema,
    productionDeploy: permissionSchema,
  }),
  workflow: z.object({
    maxFixAttempts: z.number().int().positive(),
    requiredGates: z.array(z.string()),
  }),
});

export type AgentConfig = z.infer<typeof agentConfigSchema>;

export function createDefaultConfig(detection: RepositoryDetection): AgentConfig {
  const requiredGates = detection.capabilities
    .filter(
      (capability) =>
        capability.available &&
        ["format", "lint", "typecheck", "test", "build"].includes(capability.name),
    )
    .map((capability) => capability.name);

  return {
    version: 1,
    project: {
      name: basename(detection.root),
    },
    runtime: {
      stateDirectory: ".llmatic/state",
      cacheDirectory: ".llmatic/cache",
    },
    permissions: {
      repositoryRead: "auto",
      repositoryWrite: "auto",
      taskRead: "auto",
      taskWrite: "ask",
      localProcess: "ask",
      runTests: "auto",
      runQualityGates: "auto",
      docker: "ask",
      installTools: "ask",
      gitPush: "ask",
      createPullRequest: "ask",
      mergePullRequest: "ask",
      databaseMigration: "ask",
      productionDeploy: "deny",
    },
    workflow: {
      maxFixAttempts: 5,
      requiredGates,
    },
  };
}

export function serializeConfig(config: AgentConfig): string {
  return stringify(agentConfigSchema.parse(config));
}

export function parseConfig(raw: string): AgentConfig {
  return agentConfigSchema.parse(parse(raw));
}

function normalizedWorkspaceRoot(root: string): string {
  const resolved = resolve(root);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function workspaceId(root: string): string {
  return createHash("sha256").update(normalizedWorkspaceRoot(root), "utf8").digest("hex").slice(0, 24);
}

export function workspaceConfigPath(root: string, workspaceHome: string): string {
  return resolve(workspaceHome, "workspaces", workspaceId(root), "llmatic.agent.yaml");
}

export function resolveAgentConfigPath(
  root: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const explicitPath = environment.LLMATIC_CONFIG_PATH?.trim();

  if (explicitPath) {
    return resolve(explicitPath);
  }

  const workspaceHome = environment.LLMATIC_WORKSPACE_HOME?.trim();

  if (workspaceHome) {
    return workspaceConfigPath(root, workspaceHome);
  }

  return resolve(root, "llmatic.agent.yaml");
}

export async function loadAgentConfig(
  root: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<AgentConfig> {
  const configPath = resolveAgentConfigPath(root, environment);

  try {
    const raw = await readFile(configPath, "utf8");
    return parseConfig(raw);
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : undefined;

    if (code === "ENOENT") {
      throw new Error(
        "LLMatic runtime configuration was not found at " +
          configPath +
          ". Initialize the workspace or run llmatic init.",
      );
    }

    throw error;
  }
}
