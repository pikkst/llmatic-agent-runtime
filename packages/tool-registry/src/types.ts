export const TOOL_IDS = [
  "node",
  "git",
  "pnpm",
  "docker",
  "github-cli",
  "deno",
  "supabase",
  "python",
  "uv",
  "ollama",
] as const;

export type ToolId = (typeof TOOL_IDS)[number];

export interface StructuredToolCommand {
  executable: string;
  args: string[];
}

export interface ToolInstaller {
  description: string;
  steps: StructuredToolCommand[];
}

export interface ToolDefinition {
  id: ToolId;
  name: string;
  baseline: boolean;
  probes: StructuredToolCommand[];
  installer?: ToolInstaller;
}

export interface ToolProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type ToolProcessRunner = (
  executable: string,
  args: string[],
  cwd: string,
) => ToolProcessResult;

export interface ToolDetection {
  id: ToolId;
  name: string;
  baseline: boolean;
  installed: boolean;
  version?: string;
  executable?: string;
  installerAvailable: boolean;
}

export interface ToolInstallResult {
  changed: boolean;
  tool: ToolDetection;
  executedSteps: number;
}
