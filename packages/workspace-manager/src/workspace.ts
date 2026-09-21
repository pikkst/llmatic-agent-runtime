import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  createDefaultConfig,
  detectRepository,
  managedWorkspaceConfigPath,
  managedWorkspaceDirectory,
  parseConfig,
  serializeConfig,
  workspaceId,
  type AgentConfig,
} from "@llmatic/core";

const LOCAL_EXCLUDE_PATTERNS = [".llmatic/", "llmatic.agent.local.yaml", "llmatic.agent.local.yml"];

export interface ManagedWorkspace {
  id: string;
  root: string;
  directory: string;
  configPath: string;
  stateDirectory: string;
  cacheDirectory: string;
  config: AgentConfig;
  created: boolean;
  gitExcludePath?: string;
  gitExcludeUpdated: boolean;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function writeAtomic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = path + "." + randomUUID() + ".tmp";
  await writeFile(temporary, content, "utf8");
  await rename(temporary, path);
}

async function gitDirectory(root: string): Promise<string | undefined> {
  const dotGit = resolve(root, ".git");

  try {
    const metadata = await stat(dotGit);
    if (metadata.isDirectory()) return dotGit;

    if (metadata.isFile()) {
      const raw = await readFile(dotGit, "utf8");
      const match = /^gitdir:\s*(.+)\s*$/im.exec(raw);
      if (match?.[1]) return resolve(root, match[1]);
    }
  } catch {
    return undefined;
  }

  return undefined;
}

export async function ensureLocalGitExcludes(
  root: string,
  patterns: readonly string[] = LOCAL_EXCLUDE_PATTERNS,
): Promise<{ path?: string; updated: boolean }> {
  const directory = await gitDirectory(root);
  if (!directory) return { updated: false };

  const excludePath = resolve(directory, "info", "exclude");
  await mkdir(dirname(excludePath), { recursive: true });

  let existing = "";
  try {
    existing = await readFile(excludePath, "utf8");
  } catch {
    // A missing local exclude file is normal for a new repository.
  }

  const existingLines = new Set(
    existing
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean),
  );
  const missing = patterns.filter((pattern) => !existingLines.has(pattern));

  if (missing.length === 0) return { path: excludePath, updated: false };

  const prefix = existing && !existing.endsWith("\n") ? "\n" : "";
  const block = prefix + "# LLMatic local-only workspace artifacts\n" + missing.join("\n") + "\n";

  await writeFile(excludePath, existing + block, "utf8");
  return { path: excludePath, updated: true };
}

export async function ensureManagedWorkspace(
  root: string,
  llmaticHome: string,
): Promise<ManagedWorkspace> {
  const detection = await detectRepository(root);
  const directory = managedWorkspaceDirectory(root, llmaticHome);
  const configPath = managedWorkspaceConfigPath(root, llmaticHome);
  const stateDirectory = resolve(directory, "state");
  const cacheDirectory = resolve(directory, "cache");

  await mkdir(stateDirectory, { recursive: true });
  await mkdir(cacheDirectory, { recursive: true });

  let config: AgentConfig;
  let created = false;

  if (await exists(configPath)) {
    config = parseConfig(await readFile(configPath, "utf8"));
  } else {
    config = createDefaultConfig(detection);
    config.runtime.stateDirectory = stateDirectory;
    config.runtime.cacheDirectory = cacheDirectory;
    await writeAtomic(configPath, serializeConfig(config));
    created = true;
  }

  const exclude = await ensureLocalGitExcludes(root);

  return {
    id: workspaceId(root),
    root: detection.root,
    directory,
    configPath,
    stateDirectory,
    cacheDirectory,
    config,
    created,
    gitExcludePath: exclude.path,
    gitExcludeUpdated: exclude.updated,
  };
}
