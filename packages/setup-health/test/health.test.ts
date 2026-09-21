import { describe, expect, it } from "vitest";
import { evaluateSetupHealth } from "../src/health.js";

const ready = {
  workspaceOpen: true,
  workspaceAttached: true,
  managedConfigPresent: true,
  runtimeHealthy: true,
  missingRequiredTools: [],
  kiloRequired: true,
  kiloInstalled: true,
  kiloMcpHealthy: true,
};

describe("setup health", () => {
  it("returns READY only when blocking setup and repair issues are absent", () => {
    expect(evaluateSetupHealth(ready)).toEqual({
      status: "READY",
      issues: [],
    });
  });

  it("classifies missing workspace/tools/Kilo as NEEDS_SETUP", () => {
    const health = evaluateSetupHealth({
      ...ready,
      workspaceAttached: false,
      managedConfigPresent: false,
      missingRequiredTools: ["pnpm"],
      kiloInstalled: false,
      kiloMcpHealthy: false,
    });

    expect(health.status).toBe("NEEDS_SETUP");
    expect(health.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(["workspace_unattached", "required_tools_missing", "kilo_missing"]),
    );
  });

  it("gives repair issues priority over setup issues", () => {
    const health = evaluateSetupHealth({
      ...ready,
      runtimeHealthy: false,
      missingRequiredTools: ["pnpm"],
      kiloMcpHealthy: false,
    });

    expect(health.status).toBe("NEEDS_REPAIR");
    expect(health.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(["runtime_unhealthy", "required_tools_missing", "kilo_mcp_stale"]),
    );
  });

  it("does not require Kilo when auto-connect is disabled", () => {
    expect(
      evaluateSetupHealth({
        ...ready,
        kiloRequired: false,
        kiloInstalled: false,
        kiloMcpHealthy: false,
      }).status,
    ).toBe("READY");
  });
});
