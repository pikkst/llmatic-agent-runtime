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

export async function loadAgentConfig(root: string): Promise<AgentConfig> {
  const configPath = resolve(root, "llmatic.agent.yaml");

  try {
    const raw = await readFile(configPath, "utf8");
    return parseConfig(raw);
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : undefined;

    if (code === "ENOENT") {
      throw new Error("llmatic.agent.yaml was not found. Run llmatic init first.");
    }

    throw error;
  }
}
