import { spawnSync } from "node:child_process";
import { stat } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve } from "node:path";
import type { AgentConfig, WorkflowStateStore } from "@llmatic/core";
import { recordActionCheckpoint } from "@llmatic/core";
import {
  RUNTIME_TOOL_PACKS,
  type RuntimeToolInspection,
  type RuntimeToolOperationOptions,
  type RuntimeToolOperationResult,
  type RuntimeToolPack,
  type RuntimeToolProcessResult,
  type RuntimeToolProcessRunner,
  type RuntimeToolRequest,
} from "./types.js";

interface RuntimeInput {
  script?: string;
  model?: string;
  prompt?: string;
  args?: string[];
}

interface ExecutableResolution {
  executable: string;
  prefixArgs: string[];
  version: string;
}

function defaultRunner(executable: string, args: string[], cwd: string): RuntimeToolProcessResult {
  const result = spawnSync(executable, args, {
    cwd,
    env: process.env,
    encoding: "utf8",
    shell: false,
  });

  if (result.error) {
    return {
      exitCode: 127,
      stdout: "",
      stderr: result.error.message,
    };
  }

  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function firstLine(result: RuntimeToolProcessResult): string {
  return (
    [result.stdout, result.stderr]
      .join("\n")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

function detectFirst(
  root: string,
  candidates: Array<{ executable: string; args: string[]; prefixArgs?: string[] }>,
  runner: RuntimeToolProcessRunner,
): ExecutableResolution | undefined {
  for (const candidate of candidates) {
    const result = runner(candidate.executable, candidate.args, root);
    if (result.exitCode === 0) {
      return {
        executable: candidate.executable,
        prefixArgs: candidate.prefixArgs ?? [],
        version: firstLine(result),
      };
    }
  }

  return undefined;
}

function resolvePack(
  root: string,
  pack: RuntimeToolPack,
  runner: RuntimeToolProcessRunner,
): ExecutableResolution | undefined {
  switch (pack) {
    case "docker":
      return detectFirst(root, [{ executable: "docker", args: ["--version"] }], runner);
    case "supabase":
      return detectFirst(root, [{ executable: "supabase", args: ["--version"] }], runner);
    case "python":
      return detectFirst(
        root,
        [
          { executable: "uv", args: ["--version"], prefixArgs: ["run", "--"] },
          { executable: "python", args: ["--version"] },
          { executable: "python3", args: ["--version"] },
          { executable: "py", args: ["-3", "--version"], prefixArgs: ["-3"] },
        ],
        runner,
      );
    case "ollama":
      return detectFirst(root, [{ executable: "ollama", args: ["--version"] }], runner);
  }
}

function assertPermission(
  permission: "auto" | "ask" | "deny",
  name: string,
  approved: boolean,
): void {
  if (permission === "deny") {
    throw new Error(name + " is denied by llmatic.agent.yaml.");
  }

  if (permission === "ask" && !approved) {
    throw new Error(
      name + " requires approval. Re-run with --approve after reviewing the operation.",
    );
  }
}

function validateModel(model: string): string {
  const value = model.trim();
  if (!value || !/^[A-Za-z0-9._:/-]+$/.test(value)) {
    throw new Error("Ollama model name contains unsupported characters.");
  }
  return value;
}

async function validatePythonScript(root: string, scriptInput: string): Promise<string> {
  const absolutePath = resolve(root, scriptInput);
  const rel = relative(root, absolutePath);

  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error("Python script must be a file inside the repository.");
  }

  if (![".py", ".pyw"].includes(extname(absolutePath).toLowerCase())) {
    throw new Error("Python run-script only accepts .py or .pyw files.");
  }

  const metadata = await stat(absolutePath);
  if (!metadata.isFile()) throw new Error("Python script path is not a file.");
  return rel.replaceAll("\\", "/");
}

function sanitizeSupabaseOutput(value: string): string {
  return value
    .split(/\r?\n/)
    .map((line) => {
      if (/^\s*[A-Za-z0-9 _-]*(?:secret|token|password|key)\s*:/i.test(line)) {
        return line.replace(/:\s*.*$/, ": [REDACTED]");
      }

      if (/^\s*[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|KEY)[A-Z0-9_]*=/i.test(line)) {
        return line.replace(/=.*/, "=[REDACTED]");
      }

      return line.replace(/:\/\/([^:@/\s]+):([^@/\s]+)@/g, "://$1:[REDACTED]@");
    })
    .join("\n")
    .trim();
}

function sanitized(
  pack: RuntimeToolPack,
  result: RuntimeToolProcessResult,
): RuntimeToolProcessResult {
  if (pack !== "supabase") return result;
  return {
    ...result,
    stdout: sanitizeSupabaseOutput(result.stdout),
    stderr: sanitizeSupabaseOutput(result.stderr),
  };
}

function commandText(executable: string, args: string[]): string {
  return [executable, ...args].join(" ");
}

export async function inspectRuntimeTools(
  root: string,
  runner: RuntimeToolProcessRunner = defaultRunner,
): Promise<RuntimeToolInspection[]> {
  return RUNTIME_TOOL_PACKS.map((pack) => {
    const resolution = resolvePack(root, pack, runner);

    if (!resolution) {
      return { pack, available: false };
    }

    return {
      pack,
      available: true,
      executable: resolution.executable,
      version: resolution.version,
      detail:
        pack === "python" && resolution.executable === "uv"
          ? "uv-managed Python execution"
          : undefined,
    };
  });
}

export function parseRuntimeToolOperation(
  packInput: string,
  operationInput: string,
  input: RuntimeInput = {},
): RuntimeToolRequest {
  const pack = packInput.trim().toLowerCase();
  const operation = operationInput.trim().toLowerCase();

  if (!RUNTIME_TOOL_PACKS.includes(pack as RuntimeToolPack)) {
    throw new Error("Unknown runtime tool pack: " + packInput + ".");
  }

  if (pack === "docker") {
    if (!["status", "up", "down"].includes(operation)) {
      throw new Error("Docker operation must be status, up, or down.");
    }
    return { pack: "docker", operation: operation as "status" | "up" | "down" };
  }

  if (pack === "supabase") {
    if (!["status", "start", "stop", "db-reset-local"].includes(operation)) {
      throw new Error("Supabase operation must be status, start, stop, or db-reset-local.");
    }
    return {
      pack: "supabase",
      operation: operation as "status" | "start" | "stop" | "db-reset-local",
    };
  }

  if (pack === "python") {
    if (operation !== "run-script") {
      throw new Error("Python operation must be run-script.");
    }
    if (!input.script?.trim()) throw new Error("Python run-script requires --script.");
    return {
      pack: "python",
      operation: "run-script",
      script: input.script,
      args: input.args ?? [],
    };
  }

  if (!["list", "ps", "run"].includes(operation)) {
    throw new Error("Ollama operation must be list, ps, or run.");
  }

  if (operation === "run") {
    if (!input.model?.trim()) throw new Error("Ollama run requires --model.");
    return {
      pack: "ollama",
      operation: "run",
      model: validateModel(input.model),
      prompt: input.prompt ?? "",
    };
  }

  return { pack: "ollama", operation: operation as "list" | "ps" };
}

async function commandFor(
  root: string,
  config: AgentConfig,
  request: RuntimeToolRequest,
  approved: boolean,
  runner: RuntimeToolProcessRunner,
): Promise<{ executable: string; args: string[] }> {
  const resolution = resolvePack(root, request.pack, runner);

  if (!resolution) {
    throw new Error(
      request.pack +
        " runtime is not available on PATH. Run llmatic runtime inspect or llmatic tools list.",
    );
  }

  if (request.pack === "docker") {
    if (request.operation !== "status") {
      assertPermission(config.permissions.docker, "Docker mutation", approved);
    }

    const args =
      request.operation === "status"
        ? ["compose", "ps", "--all"]
        : request.operation === "up"
          ? ["compose", "up", "--detach"]
          : ["compose", "down"];

    return { executable: resolution.executable, args };
  }

  if (request.pack === "supabase") {
    if (request.operation === "start" || request.operation === "stop") {
      assertPermission(config.permissions.docker, "Supabase local stack mutation", approved);
    }

    if (request.operation === "db-reset-local") {
      assertPermission(config.permissions.databaseMigration, "Local database reset", approved);
    }

    const args =
      request.operation === "db-reset-local" ? ["db", "reset", "--local"] : [request.operation];

    return { executable: resolution.executable, args };
  }

  if (request.pack === "python") {
    assertPermission(config.permissions.localProcess, "Local Python execution", approved);
    const script = await validatePythonScript(root, request.script);

    return {
      executable: resolution.executable,
      args: [...resolution.prefixArgs, script, ...request.args],
    };
  }

  if (request.operation === "list") {
    return { executable: resolution.executable, args: ["list"] };
  }

  if (request.operation === "ps") {
    return { executable: resolution.executable, args: ["ps"] };
  }

  assertPermission(config.permissions.localProcess, "Local model execution", approved);
  return {
    executable: resolution.executable,
    args: ["run", request.model, request.prompt],
  };
}

export async function runRuntimeToolOperation(
  root: string,
  config: AgentConfig,
  store: WorkflowStateStore,
  request: RuntimeToolRequest,
  options: RuntimeToolOperationOptions = {},
): Promise<RuntimeToolOperationResult> {
  const runner = options.runner ?? defaultRunner;

  try {
    const command = await commandFor(root, config, request, options.approved ?? false, runner);
    const raw = runner(command.executable, command.args, root);
    const result = sanitized(request.pack, raw);

    const operationResult: RuntimeToolOperationResult = {
      pack: request.pack,
      operation: request.operation,
      command: commandText(command.executable, command.args),
      exitCode: result.exitCode,
      success: result.exitCode === 0,
      stdout: result.stdout.trim(),
      stderr: result.stderr.trim(),
    };

    await recordActionCheckpoint(store, {
      provider: "runtime-tools",
      action: request.pack + "." + request.operation,
      command: operationResult.command,
      success: operationResult.success,
      detail: operationResult.success ? "exit 0" : "exit " + String(operationResult.exitCode),
      metadata: {
        pack: request.pack,
        operation: request.operation,
      },
    });

    return operationResult;
  } catch (error) {
    await recordActionCheckpoint(store, {
      provider: "runtime-tools",
      action: request.pack + "." + request.operation,
      success: false,
      detail: error instanceof Error ? error.message : String(error),
      metadata: {
        pack: request.pack,
        operation: request.operation,
      },
    });
    throw error;
  }
}
