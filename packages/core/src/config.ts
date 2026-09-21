import { basename } from "node:path";
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
    runTests: permissionSchema,
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
      runTests: "auto",
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
