import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  answerDiscoveryQuestion,
  createDiscoverySession,
  discoverySessionPath,
  isGreenfieldRepository,
  loadDiscoverySession,
  nextDiscoveryQuestion,
} from "../src/index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "llmatic-greenfield-"));
  const workspace = await mkdtemp(join(tmpdir(), "llmatic-discovery-"));
  roots.push(root, workspace);
  await mkdir(join(root, ".git"));
  await writeFile(join(root, "README.md"), "# New project\n");
  return { root, workspace };
}

describe("greenfield discovery engine", () => {
  it("recognizes an empty repository but not an implemented project", async () => {
    const { root } = await fixture();

    expect(await isGreenfieldRepository(root)).toBe(true);

    await writeFile(join(root, "package.json"), "{}\n");
    expect(await isGreenfieldRepository(root)).toBe(false);
  });

  it("stores discovery outside the repository and persists delegated decisions", async () => {
    const { root, workspace } = await fixture();
    let session = await createDiscoverySession(
      root,
      workspace,
      "Build a B2B property analysis SaaS",
    );

    expect(discoverySessionPath(workspace).startsWith(workspace)).toBe(true);
    expect(nextDiscoveryQuestion(session)?.id).toBe("product_type");

    session = await answerDiscoveryQuestion(workspace, session, "product_type", {
      mode: "delegate",
    });

    expect(session.answers.product_type).toMatchObject({
      value: "saas_web",
      source: "llmatic_delegated",
    });

    expect((await loadDiscoverySession(workspace))?.answers.product_type).toBeDefined();
  });

  it("adapts follow-up questions to earlier choices", async () => {
    const { root, workspace } = await fixture();
    let session = await createDiscoverySession(root, workspace, "Build a local CLI helper");

    session = await answerDiscoveryQuestion(workspace, session, "product_type", {
      mode: "option",
      value: "cli",
    });
    session = await answerDiscoveryQuestion(workspace, session, "maturity", {
      mode: "option",
      value: "prototype",
    });
    session = await answerDiscoveryQuestion(workspace, session, "primary_users", {
      mode: "option",
      value: "developers",
    });
    session = await answerDiscoveryQuestion(workspace, session, "application_shape", {
      mode: "recommended",
    });

    expect(nextDiscoveryQuestion(session)?.id).toBe("deployment");
  });

  it("requires explicit confirmation for recommended mode but records rationale", async () => {
    const { root, workspace } = await fixture();
    let session = await createDiscoverySession(root, workspace, "Build a new SaaS");

    session = await answerDiscoveryQuestion(workspace, session, "product_type", {
      mode: "recommended",
    });

    expect(session.answers.product_type.source).toBe("recommended_confirmed");
    expect(session.answers.product_type.rationale).toContain("web SaaS");
  });
});
