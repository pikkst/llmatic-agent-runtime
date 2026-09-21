import { describe, expect, it } from "vitest";
import { createDefaultConfig, type RepositoryDetection } from "@llmatic/core";
import {
  GitHubIssueTaskProvider,
  isGitHubIssueTaskSourceAvailable,
  type GitHubTaskProcessRunner,
} from "../src/index.js";

function config() {
  const detection: RepositoryDetection = {
    root: "/repo",
    git: true,
    packageJson: false,
    packageManager: "unknown",
    technologies: [],
    capabilities: [],
  };

  return createDefaultConfig(detection);
}

function runner(
  responses: Array<{ match: string; stdout?: string; exitCode?: number }>,
): GitHubTaskProcessRunner {
  return (_executable, args) => {
    const command = args.join(" ");
    const response = responses.find((item) => command.includes(item.match));

    return {
      exitCode: response?.exitCode ?? 0,
      stdout: response?.stdout ?? "",
      stderr: "",
    };
  };
}

describe("GitHubIssueTaskProvider", () => {
  it("normalizes issue fields, AC, DoD and dependencies", async () => {
    const provider = new GitHubIssueTaskProvider(
      "/repo",
      config(),
      runner([
        {
          match: "issue view 12",
          stdout: JSON.stringify({
            number: 12,
            title: "Build API",
            body: [
              "## Acceptance criteria",
              "- GET works",
              "",
              "## DoD",
              "- Tests pass",
              "",
              "## Dependencies",
              "- #11",
            ].join("\n"),
            state: "OPEN",
            labels: [{ name: "in-progress" }],
            assignees: [{ login: "dev" }],
            url: "https://github.com/org/repo/issues/12",
            updatedAt: "2026-09-21T00:00:00Z",
          }),
        },
      ]),
    );

    const task = await provider.getTask("#12");
    expect(task).toMatchObject({
      key: "#12",
      status: { lifecycle: "in_progress" },
      acceptanceCriteria: ["GET works"],
      definitionOfDone: ["Tests pass"],
      dependencies: ["#11"],
    });
  });

  it("uses closed dependencies when selecting next task", async () => {
    const provider = new GitHubIssueTaskProvider(
      "/repo",
      config(),
      runner([
        {
          match: "issue list",
          stdout: JSON.stringify([
            {
              number: 1,
              title: "Foundation",
              body: "",
              state: "CLOSED",
              labels: [],
              assignees: [],
            },
            {
              number: 2,
              title: "API",
              body: "## Dependencies\n- #1",
              state: "OPEN",
              labels: [],
              assignees: [],
            },
          ]),
        },
      ]),
    );

    expect((await provider.getNextTask())?.key).toBe("#2");
  });

  it("detects GitHub source only with GitHub origin and authenticated gh", () => {
    expect(
      isGitHubIssueTaskSourceAvailable(
        "/repo",
        runner([
          {
            match: "remote get-url origin",
            stdout: "git@github.com:org/repo.git\n",
          },
          {
            match: "auth status",
            stdout: "logged in\n",
          },
        ]),
      ),
    ).toBe(true);
  });
});
