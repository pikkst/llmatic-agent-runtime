import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, relative, resolve } from "node:path";
import type { AgentConfig } from "@llmatic/core";

const MAX_READ_BYTES = 256 * 1024;
const MAX_WRITE_BYTES = 512 * 1024;
const BLOCKED_DIRECTORIES = new Set([".git", ".llmatic", "node_modules"]);
const BLOCKED_FILENAMES = new Set([".env", ".npmrc", ".pypirc", "id_rsa", "id_ed25519"]);
const BLOCKED_EXTENSIONS = new Set([".pem", ".key", ".p12", ".pfx"]);

export interface WorkspaceReadResult {
  path: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  content: string;
}

export interface WorkspaceFileMutationResult {
  path: string;
  changed: boolean;
  bytes: number;
}

function assertPermission(permission: "auto" | "ask" | "deny", name: string): void {
  if (permission === "deny") {
    throw new Error(name + " is denied by llmatic.agent.yaml.");
  }

  if (permission === "ask") {
    throw new Error(
      name + " requires explicit human approval and is unavailable to the direct agent.",
    );
  }
}

export function isWorkspacePathSensitive(relativePath: string): boolean {
  const parts = relativePath.replaceAll("\\", "/").split("/");
  if (parts.some((part) => BLOCKED_DIRECTORIES.has(part))) return true;

  const name = basename(relativePath).toLowerCase();
  if (name === ".env.example") return false;
  if (BLOCKED_FILENAMES.has(name) || name.startsWith(".env.")) return true;
  return BLOCKED_EXTENSIONS.has(extname(name));
}

function containedRelative(root: string, absolutePath: string): string {
  const rel = relative(root, absolutePath);

  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error("Workspace file must resolve inside the repository.");
  }

  return rel.replaceAll("\\", "/");
}

async function containedExistingPath(
  root: string,
  input: string,
): Promise<{
  absolutePath: string;
  relativePath: string;
}> {
  if (!input.trim()) throw new Error("Workspace path must not be empty.");

  const absoluteRoot = await realpath(resolve(root));
  const actual = await realpath(resolve(absoluteRoot, input));
  const relativePath = containedRelative(absoluteRoot, actual);

  if (isWorkspacePathSensitive(relativePath)) {
    throw new Error("Workspace file is blocked by the direct-agent secret/path policy.");
  }

  return { absolutePath: actual, relativePath };
}

async function nearestExistingDirectory(path: string): Promise<string> {
  let current = path;

  while (true) {
    try {
      await access(current);
      const metadata = await stat(current);
      if (!metadata.isDirectory()) {
        throw new Error("New file parent path resolves through a non-directory.");
      }
      return current;
    } catch (error) {
      const code = error instanceof Error && "code" in error ? String(error.code) : undefined;
      if (code !== "ENOENT") throw error;

      const parent = dirname(current);
      if (parent === current) throw new Error("Unable to resolve a repository-contained parent.");
      current = parent;
    }
  }
}

async function containedNewPath(
  root: string,
  input: string,
): Promise<{
  absolutePath: string;
  relativePath: string;
}> {
  if (!input.trim()) throw new Error("Workspace path must not be empty.");

  const absoluteRoot = await realpath(resolve(root));
  const candidate = resolve(absoluteRoot, input);
  const relativePath = containedRelative(absoluteRoot, candidate);

  if (isWorkspacePathSensitive(relativePath)) {
    throw new Error("Workspace file is blocked by the direct-agent secret/path policy.");
  }

  const ancestor = await nearestExistingDirectory(dirname(candidate));
  const actualAncestor = await realpath(ancestor);
  containedRelative(absoluteRoot, actualAncestor);

  return { absolutePath: candidate, relativePath };
}

function assertText(content: Buffer): string {
  if (content.includes(0)) throw new Error("Binary files are not supported by direct-agent tools.");
  return content.toString("utf8");
}

async function writeAtomic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = path + "." + randomUUID() + ".tmp";
  await writeFile(temporary, content, "utf8");
  await rename(temporary, path);
}

export async function readWorkspaceFile(
  root: string,
  config: AgentConfig,
  path: string,
  options: { startLine?: number; endLine?: number } = {},
): Promise<WorkspaceReadResult> {
  assertPermission(config.permissions.repositoryRead, "Repository read");
  const resolved = await containedExistingPath(root, path);
  const metadata = await stat(resolved.absolutePath);

  if (!metadata.isFile()) throw new Error("Workspace path is not a file.");
  if (metadata.size > MAX_READ_BYTES) {
    throw new Error("Workspace file exceeds the 256 KiB direct-agent read limit.");
  }

  const content = assertText(await readFile(resolved.absolutePath));
  const lines = content.split(/\r?\n/);
  const startLine = Math.max(1, options.startLine ?? 1);
  const endLine = Math.min(lines.length, options.endLine ?? lines.length);

  if (endLine < startLine) throw new Error("endLine must be greater than or equal to startLine.");

  return {
    path: resolved.relativePath,
    startLine,
    endLine,
    totalLines: lines.length,
    content: lines.slice(startLine - 1, endLine).join("\n"),
  };
}

export async function replaceWorkspaceText(
  root: string,
  config: AgentConfig,
  path: string,
  oldText: string,
  newText: string,
): Promise<WorkspaceFileMutationResult> {
  assertPermission(config.permissions.repositoryWrite, "Repository write");
  if (!oldText) throw new Error("replace_in_file old_text must not be empty.");

  const resolved = await containedExistingPath(root, path);
  const metadata = await stat(resolved.absolutePath);

  if (!metadata.isFile()) throw new Error("Workspace path is not a file.");
  if (metadata.size > MAX_WRITE_BYTES) {
    throw new Error("Workspace file exceeds the 512 KiB direct-agent write limit.");
  }

  const content = assertText(await readFile(resolved.absolutePath));
  const first = content.indexOf(oldText);

  if (first < 0) throw new Error("replace_in_file old_text was not found.");
  if (content.indexOf(oldText, first + oldText.length) >= 0) {
    throw new Error(
      "replace_in_file old_text matched more than once; provide a more specific match.",
    );
  }

  const updated = content.slice(0, first) + newText + content.slice(first + oldText.length);

  if (Buffer.byteLength(updated, "utf8") > MAX_WRITE_BYTES) {
    throw new Error("Updated workspace file exceeds the 512 KiB direct-agent write limit.");
  }

  await writeAtomic(resolved.absolutePath, updated);

  return {
    path: resolved.relativePath,
    changed: updated !== content,
    bytes: Buffer.byteLength(updated, "utf8"),
  };
}

export async function createWorkspaceFile(
  root: string,
  config: AgentConfig,
  path: string,
  content: string,
): Promise<WorkspaceFileMutationResult> {
  assertPermission(config.permissions.repositoryWrite, "Repository write");
  if (Buffer.byteLength(content, "utf8") > MAX_WRITE_BYTES) {
    throw new Error("New workspace file exceeds the 512 KiB direct-agent write limit.");
  }

  const resolved = await containedNewPath(root, path);

  try {
    await stat(resolved.absolutePath);
    throw new Error("create_file refuses to overwrite an existing file.");
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : undefined;
    if (code !== "ENOENT") throw error;
  }

  await writeAtomic(resolved.absolutePath, content);

  return {
    path: resolved.relativePath,
    changed: true,
    bytes: Buffer.byteLength(content, "utf8"),
  };
}
