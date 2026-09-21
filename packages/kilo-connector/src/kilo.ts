import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { applyEdits, modify, parse } from "jsonc-parser";

export interface KiloMcpRegistration {
  homeDirectory: string;
  serverPath: string;
  llmaticHome: string;
  nodeCommand?: string;
}

export interface KiloMcpRegistrationResult {
  path: string;
  changed: boolean;
  server: {
    type: "local";
    command: string[];
    environment: Record<string, string>;
    enabled: boolean;
    timeout: number;
  };
}

export function kiloGlobalConfigPath(homeDirectory: string): string {
  return join(homeDirectory, ".config", "kilo", "kilo.jsonc");
}

async function writeAtomic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = path + "." + randomUUID() + ".tmp";
  await writeFile(temporary, content, "utf8");
  await rename(temporary, path);
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

function currentServer(raw: string): Record<string, unknown> {
  const parsed = parse(raw) as Record<string, unknown> | undefined;
  const mcp = parsed?.mcp;
  if (!mcp || typeof mcp !== "object") return {};
  const server = (mcp as Record<string, unknown>).llmatic;
  return server && typeof server === "object" ? (server as Record<string, unknown>) : {};
}

export async function ensureGlobalKiloMcpServer(
  input: KiloMcpRegistration,
): Promise<KiloMcpRegistrationResult> {
  const path = kiloGlobalConfigPath(input.homeDirectory);
  const raw = await readConfig(path);
  const existing = currentServer(raw);
  const existingEnvironment =
    existing.environment && typeof existing.environment === "object"
      ? (existing.environment as Record<string, string>)
      : {};

  const server = {
    ...existing,
    type: "local" as const,
    command: [input.nodeCommand?.trim() || "node", resolve(input.serverPath)],
    environment: {
      ...existingEnvironment,
      LLMATIC_HOME: resolve(input.llmaticHome),
    },
    enabled: true,
    timeout: 30000,
  };

  const edits = modify(raw, ["mcp", "llmatic"], server, {
    formattingOptions: {
      insertSpaces: true,
      tabSize: 2,
      eol: "\n",
    },
  });
  const updated = applyEdits(raw, edits);
  const changed = updated !== raw;

  if (changed) await writeAtomic(path, updated);

  return {
    path,
    changed,
    server: {
      type: "local",
      command: server.command,
      environment: server.environment,
      enabled: true,
      timeout: 30000,
    },
  };
}

export async function readGlobalKiloLlmaticServer(
  homeDirectory: string,
): Promise<Record<string, unknown> | undefined> {
  const path = kiloGlobalConfigPath(homeDirectory);
  const raw = await readConfig(path);
  const server = currentServer(raw);
  return Object.keys(server).length > 0 ? server : undefined;
}

export function isGlobalKiloLlmaticServerHealthy(
  server: Record<string, unknown> | undefined,
  expected: {
    serverPath: string;
    llmaticHome: string;
    nodeCommand?: string;
  },
): boolean {
  if (!server) return false;

  const command = server.command;
  const environment = server.environment;
  const expectedCommand = expected.nodeCommand?.trim() || "node";

  if (!Array.isArray(command) || command.length !== 2) return false;
  if (command[0] !== expectedCommand || command[1] !== resolve(expected.serverPath)) return false;
  if (!environment || typeof environment !== "object") return false;

  return (
    (environment as Record<string, unknown>).LLMATIC_HOME === resolve(expected.llmaticHome) &&
    server.type === "local" &&
    server.enabled === true
  );
}
