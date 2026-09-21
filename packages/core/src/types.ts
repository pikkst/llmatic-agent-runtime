export type PackageManager = "npm" | "pnpm" | "yarn" | "bun" | "unknown";

export type CapabilityName = "format" | "lint" | "typecheck" | "test" | "build" | "ci";

export interface Capability {
  name: CapabilityName;
  available: boolean;
  command?: string;
  executable?: string;
  args?: string[];
  script?: string;
  source?: string;
}

export interface RepositoryDetection {
  root: string;
  git: boolean;
  packageJson: boolean;
  packageManager: PackageManager;
  technologies: string[];
  capabilities: Capability[];
}

export type DoctorStatus = "PASS" | "WARN" | "FAIL";

export interface DoctorCheck {
  name: string;
  status: DoctorStatus;
  detail: string;
}

export interface DoctorReport {
  root: string;
  checks: DoctorCheck[];
  ready: boolean;
}

export interface CapabilityExecutionResult {
  capability: CapabilityName;
  command: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  exitCode: number;
  success: boolean;
}
