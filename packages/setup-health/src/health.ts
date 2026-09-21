export type SetupHealthStatus = "READY" | "NEEDS_SETUP" | "NEEDS_REPAIR";
export type SetupIssueKind = "setup" | "repair";

export interface SetupHealthIssue {
  code:
    | "workspace_missing"
    | "workspace_unattached"
    | "managed_config_missing"
    | "runtime_unhealthy"
    | "required_tools_missing"
    | "kilo_missing"
    | "kilo_mcp_stale"
    | "runtime_error";
  kind: SetupIssueKind;
  label: string;
  detail?: string;
}

export interface SetupHealthInput {
  workspaceOpen: boolean;
  workspaceAttached: boolean;
  managedConfigPresent: boolean;
  runtimeHealthy: boolean;
  missingRequiredTools: string[];
  kiloRequired: boolean;
  kiloInstalled: boolean;
  kiloMcpHealthy: boolean;
}

export interface SetupHealth {
  status: SetupHealthStatus;
  issues: SetupHealthIssue[];
}

export function evaluateSetupHealth(input: SetupHealthInput): SetupHealth {
  const issues: SetupHealthIssue[] = [];

  if (!input.workspaceOpen) {
    issues.push({
      code: "workspace_missing",
      kind: "setup",
      label: "Open a repository workspace",
    });
  } else if (!input.workspaceAttached) {
    issues.push({
      code: "workspace_unattached",
      kind: "setup",
      label: "Attach the workspace to LLMatic",
    });
  }

  if (input.workspaceAttached && !input.managedConfigPresent) {
    issues.push({
      code: "managed_config_missing",
      kind: "setup",
      label: "Create the external managed workspace config",
    });
  }

  if (!input.runtimeHealthy) {
    issues.push({
      code: "runtime_unhealthy",
      kind: "repair",
      label: "Repair the verified MCP runtime",
    });
  }

  if (input.missingRequiredTools.length > 0) {
    issues.push({
      code: "required_tools_missing",
      kind: "setup",
      label: "Install required engineering tools",
      detail: input.missingRequiredTools.join(", "),
    });
  }

  if (input.kiloRequired && !input.kiloInstalled) {
    issues.push({
      code: "kilo_missing",
      kind: "setup",
      label: "Install Kilo Code",
    });
  } else if (input.kiloRequired && input.kiloInstalled && !input.kiloMcpHealthy) {
    issues.push({
      code: "kilo_mcp_stale",
      kind: "repair",
      label: "Repair the global Kilo MCP registration",
    });
  }

  return {
    status: issues.some((issue) => issue.kind === "repair")
      ? "NEEDS_REPAIR"
      : issues.length > 0
        ? "NEEDS_SETUP"
        : "READY",
    issues,
  };
}
