export const RUNTIME_TOOL_PACKS = ["docker", "supabase", "python", "ollama"] as const;
export type RuntimeToolPack = (typeof RUNTIME_TOOL_PACKS)[number];

export type DockerOperation = "status" | "up" | "down";
export type SupabaseOperation = "status" | "start" | "stop" | "db-reset-local";
export type PythonOperation = "run-script";
export type OllamaOperation = "list" | "ps" | "run";

export type RuntimeToolRequest =
  | { pack: "docker"; operation: DockerOperation }
  | { pack: "supabase"; operation: SupabaseOperation }
  | { pack: "python"; operation: PythonOperation; script: string; args: string[] }
  | { pack: "ollama"; operation: "list" | "ps" }
  | { pack: "ollama"; operation: "run"; model: string; prompt: string };

export interface RuntimeToolProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type RuntimeToolProcessRunner = (
  executable: string,
  args: string[],
  cwd: string,
) => RuntimeToolProcessResult;

export interface RuntimeToolOperationOptions {
  approved?: boolean;
  runner?: RuntimeToolProcessRunner;
}

export interface RuntimeToolInspection {
  pack: RuntimeToolPack;
  available: boolean;
  executable?: string;
  version?: string;
  detail?: string;
}

export interface RuntimeToolOperationResult {
  pack: RuntimeToolPack;
  operation: string;
  command: string;
  exitCode: number;
  success: boolean;
  stdout: string;
  stderr: string;
}
