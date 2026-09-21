import type { Capability, CapabilityName, PackageManager } from "./types.js";

const SCRIPT_CANDIDATES: Record<CapabilityName, string[]> = {
  format: ["format:check", "format"],
  lint: ["lint"],
  typecheck: ["typecheck", "type-check"],
  test: ["test"],
  build: ["build"],
  ci: ["ci:local", "ci"],
};

function commandForScript(packageManager: PackageManager, script: string): string {
  switch (packageManager) {
    case "pnpm":
      return "pnpm run " + script;
    case "yarn":
      return "yarn " + script;
    case "bun":
      return "bun run " + script;
    case "npm":
    case "unknown":
    default:
      return "npm run " + script;
  }
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
      source: "package.json#" + script,
    };
  });
}
