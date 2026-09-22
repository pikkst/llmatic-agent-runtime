import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDefaultConfig, type RepositoryDetection } from "@llmatic/core";
import {
  activeRepositoryRules,
  buildRepositoryConstitution,
  decideRepositoryRuleProposal,
  proposeRepositoryRule,
  repositoryConstitutionContext,
} from "../src/index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function configFor(root: string) {
  const detection: RepositoryDetection = {
    root,
    git: true,
    packageJson: true,
    packageManager: "pnpm",
    technologies: [],
    capabilities: [],
  };
  return createDefaultConfig(detection);
}

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "llmatic-constitution-"));
  roots.push(root);
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, "test"), { recursive: true });
  await mkdir(join(root, "docs"), { recursive: true });

  await writeFile(
    join(root, "package.json"),
    JSON.stringify(
      {
        packageManager: "pnpm@10.0.0",
        scripts: {
          test: "vitest run",
          lint: "eslint .",
          build: "tsc -b",
        },
        devDependencies: {
          vitest: "2.1.9",
          eslint: "9.0.0",
          typescript: "5.9.3",
        },
      },
      null,
      2,
    ),
  );

  await writeFile(
    join(root, "AGENTS.md"),
    [
      "# Repository rules",
      "",
      "- New API endpoints must update the canonical API contract in the same change.",
      "- Do not merge when CI is red.",
      "- Prefer focused changes over unrelated refactors.",
      "",
    ].join("\n"),
  );

  await writeFile(
    join(root, "docs", "SECURITY.md"),
    [
      "# Security",
      "",
      "Authentication changes must include authorization regression tests.",
      "",
    ].join("\n"),
  );

  await writeFile(
    join(root, "docs", "architecture-rules.md"),
    [
      "# Architecture notes",
      "",
      "Historically this service must remain compatible with an older migration.",
      "",
      "# Rules",
      "",
      "New domain services must use the canonical repository abstraction.",
      "",
    ].join("\n"),
  );

  await writeFile(
    join(root, "docs", "HISTORY.md"),
    ["# History", "", "The previous implementation should have used a different worker.", ""].join(
      "\n",
    ),
  );

  await writeFile(join(root, "src", "example.ts"), "export const value = 1;\n");
  for (let index = 0; index < 5; index += 1) {
    await writeFile(join(root, "test", "feature-" + index + ".test.ts"), "export {};\n");
  }

  return root;
}

describe("repository constitution", () => {
  it("extracts explicit rules with source provenance and repository facts", async () => {
    const root = await repository();
    const constitution = await buildRepositoryConstitution(root, configFor(root));

    expect(constitution.facts.some((fact) => fact.text.includes("Quality script test"))).toBe(true);

    const apiRule = constitution.rules.find((rule) =>
      rule.text.includes("New API endpoints must update"),
    );
    expect(apiRule).toMatchObject({
      kind: "explicit_rule",
      strength: "blocking",
      confidence: 1,
      source: {
        path: "AGENTS.md",
        line: 3,
        origin: "repository",
      },
    });
    expect(apiRule?.scopes).toContain("api");
  });

  it("does not promote ordinary documentation prose to repository policy", async () => {
    const root = await repository();
    const constitution = await buildRepositoryConstitution(root, configFor(root));

    expect(
      constitution.rules.some((rule) =>
        rule.text.includes("Historically this service must remain compatible"),
      ),
    ).toBe(false);
    expect(
      constitution.rules.some((rule) =>
        rule.text.includes("previous implementation should have used"),
      ),
    ).toBe(false);
    expect(
      constitution.rules.some((rule) =>
        rule.text.includes("New domain services must use the canonical repository abstraction"),
      ),
    ).toBe(true);
  });

  it("keeps inferred conventions advisory instead of silently promoting them to policy", async () => {
    const root = await repository();
    const constitution = await buildRepositoryConstitution(root, configFor(root));

    const convention = constitution.rules.find((rule) => rule.kind === "inferred_convention");
    expect(convention).toBeDefined();
    expect(convention?.status).toBe("active");
    expect(convention?.strength).not.toBe("blocking");
    expect(activeRepositoryRules(constitution)).not.toContainEqual(convention);
  });

  it("requires an explicit approval before a proposed rule becomes active policy", async () => {
    const root = await repository();
    const config = configFor(root);

    const proposal = await proposeRepositoryRule(root, config, {
      text: "Database migrations must include a rollback or recovery note.",
      rationale: "Repeated migration review feedback.",
      scopes: ["database", "documentation"],
      strength: "blocking",
    });

    let constitution = await buildRepositoryConstitution(root, config);
    expect(constitution.counts.proposedRule).toBe(1);
    expect(activeRepositoryRules(constitution).some((rule) => rule.id === proposal.id)).toBe(false);

    await decideRepositoryRuleProposal(root, config, proposal.id, "approved");
    constitution = await buildRepositoryConstitution(root, config);

    expect(constitution.counts.approvedRule).toBe(1);
    expect(activeRepositoryRules(constitution).some((rule) => rule.id === proposal.id)).toBe(true);
    expect(repositoryConstitutionContext(constitution)).toContain(proposal.id);
  });
});
