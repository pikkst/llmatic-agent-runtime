import type { ToolId, ToolInstallResult } from "@llmatic/tool-registry";

export type BootstrapRequirementLevel = "required" | "recommended" | "optional";

export interface BootstrapRequirement {
  id: ToolId;
  name: string;
  level: BootstrapRequirementLevel;
  reason: string;
  installed: boolean;
  version?: string;
  installerAvailable: boolean;
}

export interface BootstrapReport {
  root: string;
  ready: boolean;
  requirements: BootstrapRequirement[];
  unsupportedPackageManager?: string;
}

export interface BootstrapRemediationOptions {
  approved?: boolean;
}

export interface BootstrapRemediationResult {
  report: BootstrapReport;
  installations: ToolInstallResult[];
}
