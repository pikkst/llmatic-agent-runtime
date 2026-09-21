import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import type { GitExcludeResult } from "./types.js";

const DEFAULT_PATTERNS = [".llmatic/", "llmatic.agent.local.yaml"];

function gitExcludePath(root: string): string | undefined {
  const result = spawnSync("git", ["rev-parse", "--git-path", "info/exclude"], {
    cwd: root,
    env: process.env,
    encoding: "utf8",
    shell: false,
  });

  if (result.status !== 0) return undefined;

  const value = result.stdout.trim();
  if (!value) return undefined;
  return isAbsolute(value) ? value : resolve(root, value);
}

export async function ensureLlmaticGitExclude(
  root: string,
  patterns: readonly string[] = DEFAULT_PATTERNS,
): Promise<GitExcludeResult> {
  const path = gitExcludePath(root);

  if (!path) {
    return { supported: false, changed: false };
  }

  let existing = "";

  try {
    existing = await readFile(path, "utf8");
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : undefined;
    if (code !== "ENOENT") throw error;
  }

  const lines = new Set(
    existing
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean),
  );
  const missing = patterns.filter((pattern) => !lines.has(pattern));

  if (missing.length === 0) {
    return { supported: true, changed: false, path };
  }

  await mkdir(dirname(path), { recursive: true });

  const prefix = existing && !existing.endsWith("\n") ? "\n" : "";
  const marker = lines.has("# LLMatic Agent Runtime (local only)")
    ? ""
    : "# LLMatic Agent Runtime (local only)\n";

  await writeFile(path, existing + prefix + marker + missing.join("\n") + "\n", "utf8");

  return { supported: true, changed: true, path };
}
