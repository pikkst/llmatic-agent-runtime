import { describe, expect, it } from "vitest";
import { createDefaultConfig } from "@llmatic/core";
import type { RepositoryDetection } from "@llmatic/core";
import {
  DEFAULT_TOOL_REGISTRY,
  detectRegisteredTools,
  installRegisteredTool,
} from "../src/registry.js";
import type { ToolProcessRunner } from "../src/types.js";

function config() {
  const detection: RepositoryDetection = {
    root: "/repo",
    git: true,
    packageJson: true,
    packageManager: "pnpm",
    technologies: [],
    capabilities: [],
  };

  return createDefaultConfig(detection);
}

describe("tool registry", () => {
  it("detects installed and missing tools through structured probes", async () => {
    const runner: ToolProcessRunner = (executable) => {
      if (executable === "node") {
        return { exitCode: 0, stdout: "v22.0.0\n", stderr: "" };
      }

      if (executable === "git") {
        return { exitCode: 0, stdout: "git version 2.50.0\n", stderr: "" };
      }

      return { exitCode: 127, stdout: "", stderr: "not found" };
    };

    const statuses = await detectRegisteredTools("/repo", DEFAULT_TOOL_REGISTRY, runner);

    expect(statuses.find((tool) => tool.id === "node")).toMatchObject({
      installed: true,
      version: "v22.0.0",
    });
    expect(statuses.find((tool) => tool.id === "docker")?.installed).toBe(false);
  });

  it("requires approval before running an ask-gated installer", async () => {
    const runtimeConfig = config();
    const runner: ToolProcessRunner = () => ({
      exitCode: 127,
      stdout: "",
      stderr: "not found",
    });

    await expect(installRegisteredTool("/repo", runtimeConfig, "pnpm", { runner })).rejects.toThrow(
      "requires approval",
    );
  });

  it("runs the pnpm installer as structured Corepack steps", async () => {
    const runtimeConfig = config();
    let pnpmInstalled = false;
    const calls: Array<{ executable: string; args: string[] }> = [];

    const runner: ToolProcessRunner = (executable, args) => {
      calls.push({ executable, args });

      if (executable === "pnpm") {
        return pnpmInstalled
          ? { exitCode: 0, stdout: "10.17.1\n", stderr: "" }
          : { exitCode: 127, stdout: "", stderr: "not found" };
      }

      if (executable === "corepack") {
        if (args[0] === "prepare") {
          pnpmInstalled = true;
        }

        return { exitCode: 0, stdout: "", stderr: "" };
      }

      return { exitCode: 127, stdout: "", stderr: "not found" };
    };

    const result = await installRegisteredTool("/repo", runtimeConfig, "pnpm", {
      approved: true,
      runner,
    });

    expect(result.changed).toBe(true);
    expect(result.executedSteps).toBe(2);
    expect(result.tool).toMatchObject({
      installed: true,
      version: "10.17.1",
    });
    expect(
      calls.filter((call) => call.executable === "corepack").map((call) => call.args[0]),
    ).toEqual(["enable", "prepare"]);
  });

  it("rejects tools without automated installers", async () => {
    const runtimeConfig = config();
    const runner: ToolProcessRunner = () => ({
      exitCode: 127,
      stdout: "",
      stderr: "not found",
    });

    await expect(
      installRegisteredTool("/repo", runtimeConfig, "docker", {
        approved: true,
        runner,
      }),
    ).rejects.toThrow("No automated installer");
  });
});
