import { createHash } from "node:crypto";
import { resolve } from "node:path";

export function normalizeWorkspaceRoot(root: string): string {
  let normalized = resolve(root).replaceAll("\\", "/");

  if (process.platform === "win32") {
    normalized = normalized.toLowerCase();
  }

  return normalized.replace(/\/+$/, "");
}

export function workspaceId(root: string): string {
  return createHash("sha256").update(normalizeWorkspaceRoot(root)).digest("hex").slice(0, 32);
}

export function managedWorkspaceDirectory(root: string, llmaticHome: string): string {
  return resolve(llmaticHome, "workspaces", workspaceId(root));
}

export function managedWorkspaceConfigPath(root: string, llmaticHome: string): string {
  return resolve(managedWorkspaceDirectory(root, llmaticHome), "llmatic.agent.yaml");
}
