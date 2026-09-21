import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { applyEdits, modify, parse } from "jsonc-parser";
import type { KiloMcpRegistration, KiloMcpStatus } from "./types.js";

const SERVER_NAME = "llmatic";

export function defaultKiloConfigPath(home = homedir()): string {
  return resolve(home, ".config", "kilo", "kilo.jsonc");
}

async function readConfig(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : undefined;
    if (code === "ENOENT") return "{}\n";
    throw error;
  }
}

export async function registerGlobalKiloMcp(
  serverPath: string,
  workspaceHome: string,
  options: { configPath?: string; nodeCommand?: string } = {},
): Promise<KiloMcpRegistration> {
  const configPath = options.configPath ?? defaultKiloConfigPath();
  const nodeCommand = options.nodeCommand?.trim() || "node";
  const command = [nodeCommand, resolve(serverPath)];
  const environment = {
    LLMATIC_WORKSPACE_HOME: resolve(workspaceHome),
  };
  const value = {
    type: "local",
    command,
    environment,
    enabled: true,
    timeout: 30000,
  };

  const raw = await readConfig(configPath);
  const edits = modify(raw, ["mcp", SERVER_NAME], value, {
    formattingOptions: {
      insertSpaces: true,
      tabSize: 2,
      eol: "\n",
    },
  });
  const updated = applyEdits(raw, edits);

  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, updated.endsWith("\n") ? updated : updated + "\n", "utf8");

  return {
    configPath,
    serverName: SERVER_NAME,
    command,
    environment,
  };
}

export async function readGlobalKiloMcpStatus(
  options: { configPath?: string } = {},
): Promise<KiloMcpStatus> {
  const configPath = options.configPath ?? defaultKiloConfigPath();
  const raw = await readConfig(configPath);
  const document = parse(raw) as Record<string, unknown> | undefined;
  const mcp = document?.mcp as Record<string, unknown> | undefined;
  const server = mcp?.[SERVER_NAME] as Record<string, unknown> | undefined;

  return {
    configPath,
    configured: Boolean(server),
    enabled: server?.enabled !== false,
    command: Array.isArray(server?.command)
      ? server.command.filter((item): item is string => typeof item === "string")
      : undefined,
    workspaceHome:
      server?.environment &&
      typeof server.environment === "object" &&
      typeof (server.environment as Record<string, unknown>).LLMATIC_WORKSPACE_HOME === "string"
        ? String((server.environment as Record<string, unknown>).LLMATIC_WORKSPACE_HOME)
        : undefined,
  };
}
