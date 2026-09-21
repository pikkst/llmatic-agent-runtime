import type { AgentConfig } from "@llmatic/core";

export interface PrivateWorkspacePaths {
  workspaceId: string;
  workspaceDirectory: string;
  configPath: string;
  stateDirectory: string;
  cacheDirectory: string;
}

export interface PrivateWorkspace {
  root: string;
  paths: PrivateWorkspacePaths;
  config: AgentConfig;
}

export interface GitExcludeResult {
  supported: boolean;
  changed: boolean;
  path?: string;
}

export interface KiloMcpRegistration {
  configPath: string;
  serverName: string;
  command: string[];
  environment: Record<string, string>;
}

export interface KiloMcpStatus {
  configPath: string;
  configured: boolean;
  enabled: boolean;
  command?: string[];
  workspaceHome?: string;
}
