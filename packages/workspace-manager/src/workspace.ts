import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  createDefaultConfig,
  detectRepository,
  serializeConfig,
  workspaceConfigPath,
  workspaceId,
  type AgentConfig,
} from "@llmatic/core";
import type { PrivateWorkspace, PrivateWorkspacePaths } from "./types.js";

export function privateWorkspacePaths(
  root: string,
  workspaceHome: string,
): PrivateWorkspacePaths {
  const id = workspaceId(root);
  const workspaceDirectory = resolve(workspaceHome, "workspaces", id);

  return {
    workspaceId: id,
    workspaceDirectory,
    configPath: workspaceConfigPath(root, workspaceHome),
    stateDirectory: resolve(workspaceDirectory, "state"),
    cacheDirectory: resolve(workspaceDirectory, "cache"),
  };
}

export async function writePrivateWorkspaceConfig(
  path: string,
  config: AgentConfig,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = path + ".tmp";
  await writeFile(temporaryPath, serializeConfig(config), "utf8");

  try {
    await rename(temporaryPath, path);
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : undefined;

    if (code !== "EEXIST" && code !== "EPERM") {
      await rm(temporaryPath, { force: true });
      throw error;
    }

    await rm(path, { force: true });
    await rename(temporaryPath, path);
  }
}

export async function initializePrivateWorkspace(
  root: string,
  workspaceHome: string,
): Promise<PrivateWorkspace> {
  const detection = await detectRepository(root);

  if (!detection.git) {
    throw new Error("LLMatic VS Code workspace initialization requires a Git repository.");
  }

  const paths = privateWorkspacePaths(root, workspaceHome);
  const config = createDefaultConfig(detection);

  config.runtime.stateDirectory = paths.stateDirectory;
  config.runtime.cacheDirectory = paths.cacheDirectory;

  await mkdir(paths.stateDirectory, { recursive: true });
  await mkdir(paths.cacheDirectory, { recursive: true });

  try {
    const existing = await readFile(paths.configPath, "utf8");

    if (existing.trim()) {
      return {
        root: resolve(root),
        paths,
        config,
      };
    }
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : undefined;
    if (code !== "ENOENT") throw error;
  }

  await writePrivateWorkspaceConfig(paths.configPath, config);

  return {
    root: resolve(root),
    paths,
    config,
  };
}
