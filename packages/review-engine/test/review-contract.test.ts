import { describe, expect, it } from "vitest";
import type { RepositoryConstitution } from "@llmatic/repository-constitution";
import { buildReviewContract, reviewContractAcceptanceEvidence } from "../src/review-contract.js";

function constitution(): RepositoryConstitution {
  return {
    version: 1,
    root: "/repo",
    generatedAt: "2026-09-25T00:00:00.000Z",
    sourceFiles: ["AGENTS.md", "docs/API.md", "docs/DATABASE.md", "docs/UI.md"],
    facts: [],
    rules: [
      {
        id: "RULE-GLOBAL",
        kind: "explicit_rule",
        text: "Every pull request must keep tests passing.",
        strength: "blocking",
        confidence: 1,
        scopes: ["testing"],
        source: { path: "AGENTS.md", line: 10, origin: "repository" },
        status: "active",
      },
      {
        id: "RULE-API",
        kind: "explicit_rule",
        text: "API changes must update the route contract.",
        strength: "blocking",
        confidence: 1,
        scopes: ["api"],
        source: { path: "docs/API.md", line: 20, origin: "repository" },
        status: "active",
      },
      {
        id: "RULE-DB",
        kind: "explicit_rule",
        text: "Database migrations must preserve rollback safety.",
        strength: "blocking",
        confidence: 1,
        scopes: ["database"],
        source: { path: "docs/DATABASE.md", line: 30, origin: "repository" },
        status: "active",
      },
      {
        id: "RULE-UI",
        kind: "explicit_rule",
        text: "UI components should preserve mobile spacing.",
        strength: "advisory",
        confidence: 1,
        scopes: ["frontend"],
        source: { path: "docs/UI.md", line: 40, origin: "repository" },
        status: "active",
      },
      {
        id: "RULE-INFERRED",
        kind: "inferred_convention",
        text: "Prefer one helper per file.",
        strength: "advisory",
        confidence: 0.7,
        scopes: ["repository"],
        source: { path: "src/value.ts", origin: "repository" },
        status: "active",
      },
    ],
    counts: {
      fact: 0,
      explicitRule: 4,
      inferredConvention: 1,
      approvedRule: 0,
      proposedRule: 0,
      blocking: 3,
      advisory: 2,
    },
  };
}

describe("review contract", () => {
  it("normalizes linked task and PR requirements with provenance", () => {
    const contract = buildReviewContract({
      headRefOid: "abc123",
      title: "KT-123: harden API validation",
      body: "## Acceptance Criteria\n- Preserve existing API compatibility\n",
      changedFiles: ["src/server/api.ts", "src/server/api.test.ts"],
      constitution: constitution(),
      linkedTask: {
        provider: "Jira",
        key: "KT-123",
        summary: "Harden API validation",
        webUrl: "https://example.atlassian.net/browse/KT-123",
        acceptanceCriteria: ["Reject unknown references"],
        definitionOfDone: ["Tests pass"],
      },
    });

    expect(contract.task).toEqual({
      provider: "Jira",
      key: "KT-123",
      summary: "Harden API validation",
      webUrl: "https://example.atlassian.net/browse/KT-123",
    });
    expect(contract.requirements).toHaveLength(3);
    expect(contract.requirements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "acceptance_criterion",
          text: "Reject unknown references",
          referenceText: "[Jira KT-123 AC] Reject unknown references",
          source: expect.objectContaining({
            kind: "task",
            provider: "Jira",
            reference: "KT-123",
          }),
        }),
        expect.objectContaining({
          kind: "definition_of_done",
          text: "Tests pass",
          referenceText: "[Jira KT-123 DoD] Tests pass",
        }),
        expect.objectContaining({
          kind: "pull_request_acceptance",
          text: "Preserve existing API compatibility",
          source: expect.objectContaining({ kind: "pull_request" }),
        }),
      ]),
    );
    expect(reviewContractAcceptanceEvidence(contract)).toEqual(
      expect.arrayContaining([
        "[Jira KT-123 AC] Reject unknown references",
        "[Jira KT-123 DoD] Tests pass",
        "Preserve existing API compatibility",
      ]),
    );
  });

  it("selects relevant active rules instead of the whole Constitution", () => {
    const contract = buildReviewContract({
      headRefOid: "abc123",
      title: "Update API endpoint",
      body: "",
      changedFiles: ["src/server/api.ts"],
      constitution: constitution(),
    });

    expect(contract.scopes).toContain("api");
    expect(contract.rules.map((rule) => rule.id)).toContain("RULE-API");
    expect(contract.rules.map((rule) => rule.id)).not.toContain("RULE-GLOBAL");
    expect(contract.rules.map((rule) => rule.id)).not.toContain("RULE-DB");
    expect(contract.rules.map((rule) => rule.id)).not.toContain("RULE-UI");
    expect(contract.rules.map((rule) => rule.id)).not.toContain("RULE-INFERRED");
    expect(contract.requiredEvidence).toContain("api_contract");
  });

  it("derives applicable security/database invariants and required evidence", () => {
    const source = constitution();
    source.rules.push({
      id: "RULE-SECURITY",
      kind: "approved_rule",
      text: "Authorization changes must preserve tenant isolation.",
      strength: "blocking",
      confidence: 1,
      scopes: ["security"],
      source: { path: "docs/SECURITY.md", line: 5, origin: "approved" },
      status: "active",
    });
    source.counts.approvedRule = 1;
    source.counts.blocking += 1;

    const contract = buildReviewContract({
      headRefOid: "abc123",
      title: "Authorization database migration",
      body: "",
      changedFiles: ["src/auth/policy.ts", "supabase/migrations/001.sql"],
      constitution: source,
    });

    expect(contract.scopes).toEqual(expect.arrayContaining(["security", "database"]));
    expect(contract.invariants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "security",
          text: expect.stringContaining("tenant isolation"),
        }),
        expect.objectContaining({
          kind: "database",
          text: expect.stringContaining("rollback safety"),
        }),
      ]),
    );
    expect(contract.requiredEvidence).toEqual(
      expect.arrayContaining(["implementation", "security", "database_schema"]),
    );
  });

  it("fails contract completeness closed when authoritative task evidence is unavailable", () => {
    const contract = buildReviewContract({
      headRefOid: "abc123",
      title: "KT-999: update worker",
      body: "",
      changedFiles: ["src/worker.ts"],
      constitution: constitution(),
      acceptanceEvidenceUnavailableReason:
        "could not load KT-999 acceptance criteria / Definition of Done",
    });

    expect(contract.completeness).toBe("partial");
    expect(contract.warnings).toContain(
      "could not load KT-999 acceptance criteria / Definition of Done",
    );
  });

  it("keeps legacy supplied acceptance evidence without inventing task identity", () => {
    const contract = buildReviewContract({
      headRefOid: "abc123",
      title: "Legacy caller",
      body: "",
      changedFiles: ["src/value.ts"],
      constitution: constitution(),
      supplementalAcceptanceEvidence: ["[Jira KT-1 AC] Legacy requirement"],
      supplementalAcceptanceEvidenceSource: "Jira KT-1",
    });

    expect(contract.task).toBeUndefined();
    expect(contract.requirements).toEqual([
      expect.objectContaining({
        source: expect.objectContaining({
          kind: "provided",
          label: "Jira KT-1",
        }),
        referenceText: "[Jira KT-1 AC] Legacy requirement",
      }),
    ]);
  });

  it("keeps auth diagnostics rules focused and excludes unrelated subsystem rules", () => {
    const source = constitution();
    source.rules.push(
      {
        id: "RULE-AUTH-ADMIN",
        kind: "approved_rule",
        text: "Admin auth diagnostics must derive actor identity from auth uid and remain read only.",
        strength: "blocking",
        confidence: 1,
        scopes: ["security", "api"],
        source: { path: "docs/AUTH_SECURITY.md", line: 12, origin: "approved" },
        status: "active",
      },
      {
        id: "RULE-STRIPE",
        kind: "approved_rule",
        text: "Stripe secret and payment API keys must remain server side.",
        strength: "blocking",
        confidence: 1,
        scopes: ["security", "api"],
        source: { path: "docs/PAYMENTS.md", line: 8, origin: "approved" },
        status: "active",
      },
      {
        id: "RULE-TILES",
        kind: "approved_rule",
        text: "Map tile requests must use the fixed GIS tile proxy endpoint.",
        strength: "blocking",
        confidence: 1,
        scopes: ["api", "architecture"],
        source: { path: "docs/MAPS.md", line: 9, origin: "approved" },
        status: "active",
      },
    );
    source.counts.approvedRule += 3;
    source.counts.blocking += 3;

    const contract = buildReviewContract({
      headRefOid: "kt271-head",
      title: "feat(KT-271): add admin identity and auth diagnostics",
      body: "",
      changedFiles: [
        "src/features/admin/AdminIdentityAuthPage.tsx",
        "src/lib/admin-identity-auth/api.ts",
        "src/lib/auth-diagnostics/telemetry.ts",
        "supabase/migrations/20260927220000_kt271_admin_identity_auth_diagnostics.sql",
      ],
      constitution: source,
      linkedTask: {
        provider: "Jira",
        key: "KT-271",
        summary: "Admin Identity & Auth Diagnostics",
        acceptanceCriteria: [
          "No password, OTP, OAuth token or service-role secret is exposed.",
          "Cross-user ownership anomalies can be diagnosed safely.",
        ],
        definitionOfDone: ["Tests and build pass."],
      },
    });

    const ids = contract.rules.map((rule) => rule.id);
    expect(ids).toContain("RULE-AUTH-ADMIN");
    expect(ids).not.toContain("RULE-STRIPE");
    expect(ids).not.toContain("RULE-TILES");
    expect(contract.rules.length).toBeLessThan(12);
    expect(contract.invariants.length).toBeLessThanOrEqual(6);
  });

  it("keeps EHR source-contract reviews below caps without admin or tile subsystem leakage", () => {
    const source = constitution();
    source.rules.push(
      {
        id: "RULE-EHR-CONTRACT",
        kind: "approved_rule",
        text: "EHR source contracts must fail closed until provider access and source semantics are verified.",
        strength: "blocking",
        confidence: 1,
        scopes: ["api", "security", "architecture"],
        source: { path: "docs/EHR_SOURCE_CONTRACT.md", line: 4, origin: "approved" },
        status: "active",
      },
      {
        id: "RULE-ADMIN-AUTH",
        kind: "approved_rule",
        text: "Administrator auth routes must preserve the canonical admin session guard.",
        strength: "blocking",
        confidence: 1,
        scopes: ["api", "security"],
        source: { path: "docs/ADMIN_AUTH.md", line: 7, origin: "approved" },
        status: "active",
      },
      {
        id: "RULE-TILE-PROXY",
        kind: "approved_rule",
        text: "Map tile requests must use the fixed GIS tile proxy endpoint.",
        strength: "blocking",
        confidence: 1,
        scopes: ["api", "architecture"],
        source: { path: "docs/MAPS.md", line: 9, origin: "approved" },
        status: "active",
      },
    );
    source.counts.approvedRule += 3;
    source.counts.blocking += 3;

    const contract = buildReviewContract({
      headRefOid: "kt135-head",
      title: "docs(KT-135): verify and fail-close EHR source contract",
      body: "",
      changedFiles: [
        "docs/KT-135_EHR_ACCESS_CONTRACT.md",
        "docs/KT-135_EHR_DOWNSTREAM_COMPATIBILITY.md",
        "src/domain/source/registry.ts",
        "supabase/migrations/20260928023000_kt135_ehr_fail_closed_policy.sql",
      ],
      constitution: source,
      linkedTask: {
        provider: "Jira",
        key: "KT-135",
        summary: "Verify current EHR API access/terms",
        acceptanceCriteria: [
          "Authentication/access prerequisites and credential handling are documented.",
          "Browser-direct versus server-side architecture is decided with privacy and security implications.",
        ],
        definitionOfDone: ["Tests and build pass."],
      },
    });

    const ids = contract.rules.map((rule) => rule.id);
    expect(ids).toContain("RULE-EHR-CONTRACT");
    expect(ids).not.toContain("RULE-ADMIN-AUTH");
    expect(ids).not.toContain("RULE-TILE-PROXY");
    expect(contract.rules.length).toBeLessThan(12);
    expect(contract.invariants.length).toBeLessThan(6);
  });
});
