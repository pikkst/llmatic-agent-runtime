import type { Capability, CapabilityName, PackageManager } from "./types.js";

const SCRIPT_CANDIDATES: Record<CapabilityName, string[]> = {
  format: ["format:check", "format"],
  lint: ["lint"],
  typecheck: ["typecheck", "type-check"],
  test: ["test"],
  build: ["build"],
  ci: ["ci:local", "ci"],
};

function executableForPackageManager(packageManager: PackageManager): string {
  return packageManager === "unknown" ? "npm" : packageManager;
}

function argsForScript(packageManager: PackageManager, script: string): string[] {
  if (packageManager === "yarn") {
    return [script];
  }

  return ["run", script];
}

function commandForScript(packageManager: PackageManager, script: string): string {
  return [executableForPackageManager(packageManager), ...argsForScript(packageManager, script)].join(
    " ",
  );
}

export function detectCapabilities(
  scripts: Record<string, string>,
  packageManager: PackageManager,
): Capability[] {
  return (Object.keys(SCRIPT_CANDIDATES) as CapabilityName[]).map((name) => {
    const candidates = SCRIPT_CANDIDATES[name];
    const script = candidates.find((candidate) => typeof scripts[candidate] === "string");

    if (!script) {
      return {
        name,
        available: false,
      };
    }

    return {
      name,
      available: true,
      command: commandForScript(packageManager, script),
      executable: executableForPackageManager(packageManager),
      args: argsForScript(packageManager, script),
      script,
      source: "package.json#" + script,
    };
  });
}
