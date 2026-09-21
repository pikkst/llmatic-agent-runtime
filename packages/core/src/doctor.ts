import { spawnSync } from "node:child_process";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { detectRepository } from "./detect.js";
import type { DoctorCheck, DoctorReport, DoctorStatus } from "./types.js";

function commandVersion(command: string): string | undefined {
  const result = spawnSync(command, ["--version"], {
    encoding: "utf8",
    shell: process.platform === "win32",
  });

  if (result.status !== 0) {
    return undefined;
  }

  return (result.stdout || result.stderr).trim().split(/\r?\n/)[0];
}

function check(name: string, status: DoctorStatus, detail: string): DoctorCheck {
  return { name, status, detail };
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function runDoctor(inputRoot: string): Promise<DoctorReport> {
  const detection = await detectRepository(inputRoot);
  const checks: DoctorCheck[] = [];

  const nodeVersion = commandVersion("node");
  if (!nodeVersion) {
    checks.push(check("Node.js", "FAIL", "Node.js is not available on PATH."));
  } else {
    const major = Number(nodeVersion.replace(/^v/, "").split(".")[0]);
    checks.push(
      check(
        "Node.js",
        major >= 20 ? "PASS" : "FAIL",
        nodeVersion + (major >= 20 ? "" : " (Node.js 20+ required)"),
      ),
    );
  }

  const gitVersion = commandVersion("git");
  checks.push(
    gitVersion
      ? check("Git", "PASS", gitVersion)
      : check("Git", "FAIL", "Git is not available on PATH."),
  );

  checks.push(
    detection.git
      ? check("Repository", "PASS", "Git repository detected.")
      : check("Repository", "FAIL", "No .git directory found."),
  );

  checks.push(
    detection.packageJson
      ? check("package.json", "PASS", "Node package metadata detected.")
      : check(
          "package.json",
          "WARN",
          "No package.json detected; Node capabilities are unavailable.",
        ),
  );

  if (detection.packageManager !== "unknown") {
    const version = commandVersion(detection.packageManager);
    checks.push(
      version
        ? check("Package manager", "PASS", detection.packageManager + " " + version)
        : check(
            "Package manager",
            "FAIL",
            detection.packageManager + " is selected but unavailable on PATH.",
          ),
    );
  } else {
    checks.push(check("Package manager", "WARN", "No package manager detected."));
  }

  const availableCapabilities = detection.capabilities.filter(
    (capability) => capability.available,
  );
  checks.push(
    availableCapabilities.length > 0
      ? check(
          "Capabilities",
          "PASS",
          availableCapabilities.map((capability) => capability.name).join(", "),
        )
      : check("Capabilities", "WARN", "No standard quality-gate scripts detected."),
  );

  const configPath = join(detection.root, "llmatic.agent.yaml");
  checks.push(
    (await fileExists(configPath))
      ? check("Runtime config", "PASS", "llmatic.agent.yaml found.")
      : check("Runtime config", "WARN", "Run llmatic init to create runtime configuration."),
  );

  return {
    root: detection.root,
    checks,
    ready: !checks.some((item) => item.status === "FAIL"),
  };
}
