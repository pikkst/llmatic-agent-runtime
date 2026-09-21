import { access } from "node:fs/promises";
import { resolve } from "node:path";

export type ArchitectureImpactArea =
  "architecture" | "api_contract" | "schema" | "security" | "testing" | "operations" | "task_graph";

export interface ArchitectureImpactItem {
  area: ArchitectureImpactArea;
  required: boolean;
  resolved: boolean;
  reasons: string[];
  resolutionPaths: string[];
  changedResolutionPaths: string[];
  recommendation: string;
}

export interface ArchitectureImpactReport {
  baselineDetected: boolean;
  changedFiles: string[];
  impacts: ArchitectureImpactItem[];
  requiredCount: number;
  unresolvedCount: number;
  unresolvedAreas: ArchitectureImpactArea[];
}

interface ImpactRule {
  area: ArchitectureImpactArea;
  triggers: (path: string) => boolean;
  resolutionPaths: string[];
  resolves: (path: string) => boolean;
  recommendation: string;
}

function normalized(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\/+/, "");
}

function isCode(path: string): boolean {
  if (!/\.(?:[cm]?[jt]sx?|py|rs|go|java|kt|cs)$/i.test(path)) {
    return false;
  }

  return !isTest(path) && !path.startsWith("docs/");
}

function isTest(path: string): boolean {
  return (
    /(?:^|\/)(?:test|tests|__tests__)(?:\/|$)/i.test(path) ||
    /\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(path) ||
    /_test\.py$/i.test(path)
  );
}

function isPlanningDecision(path: string): boolean {
  return (
    path === "docs/planning/ARCHITECTURE.md" ||
    path === "docs/planning/API_CONTRACTS.md" ||
    path === "docs/planning/DATA_MODEL.md" ||
    path === "docs/planning/SECURITY.md" ||
    path === "docs/planning/OPERATIONS.md" ||
    path.startsWith("docs/planning/adr/")
  );
}

const RULES: ImpactRule[] = [
  {
    area: "architecture",
    triggers: (path) =>
      path === "package.json" ||
      path === "pnpm-workspace.yaml" ||
      path === "tsconfig.json" ||
      /^(?:apps|packages)\/[^/]+\/(?:package\.json|tsconfig(?:\.[^/]+)?\.json)$/.test(path) ||
      /^(?:Dockerfile|docker-compose\.ya?ml|compose\.ya?ml)$/.test(path) ||
      path.startsWith(".github/workflows/"),
    resolutionPaths: ["docs/planning/ARCHITECTURE.md", "docs/planning/adr/"],
    resolves: (path) =>
      path === "docs/planning/ARCHITECTURE.md" || path.startsWith("docs/planning/adr/"),
    recommendation:
      "Update ARCHITECTURE.md or add/update an ADR that explains the structural/tooling/deployment change.",
  },
  {
    area: "api_contract",
    triggers: (path) =>
      path.startsWith("apps/api/") ||
      /(?:^|\/)(?:api|routes?|controllers?|handlers?|http|openapi)(?:\/|\.|$)/i.test(path),
    resolutionPaths: ["docs/planning/API_CONTRACTS.md", "packages/contracts/", "openapi"],
    resolves: (path) =>
      path === "docs/planning/API_CONTRACTS.md" ||
      path.startsWith("packages/contracts/") ||
      /(?:^|\/)openapi(?:\/|\.|$)/i.test(path),
    recommendation:
      "Synchronize the API contract: update API_CONTRACTS.md or the canonical typed/OpenAPI contract in the same change.",
  },
  {
    area: "schema",
    triggers: (path) =>
      /(?:^|\/)(?:migrations?|schema|schemas)(?:\/|\.|$)/i.test(path) ||
      (/(?:^|\/)(?:prisma|supabase)(?:\/|$)/i.test(path) &&
        /(?:migration|schema|\.sql$)/i.test(path)),
    resolutionPaths: ["docs/planning/DATA_MODEL.md"],
    resolves: (path) => path === "docs/planning/DATA_MODEL.md",
    recommendation:
      "Update DATA_MODEL.md to reflect the persisted schema/invariant change and keep migration evidence in the same change.",
  },
  {
    area: "security",
    triggers: (path) =>
      /(?:^|\/)(?:auth|security|permissions?|authorization|rbac|rls|policies?)(?:\/|\.|$)/i.test(
        path,
      ),
    resolutionPaths: ["docs/planning/SECURITY.md"],
    resolves: (path) => path === "docs/planning/SECURITY.md",
    recommendation:
      "Update SECURITY.md with the affected trust boundary, authorization rule or policy behavior.",
  },
  {
    area: "operations",
    triggers: (path) =>
      /^(?:Dockerfile|docker-compose\.ya?ml|compose\.ya?ml)$/.test(path) ||
      /(?:^|\/)(?:deploy|deployment|infra|infrastructure|terraform|k8s|kubernetes|helm)(?:\/|\.|$)/i.test(
        path,
      ) ||
      /^\.github\/workflows\/(?:deploy|release|production|infra)[^/]*\.ya?ml$/i.test(path),
    resolutionPaths: ["docs/planning/OPERATIONS.md"],
    resolves: (path) => path === "docs/planning/OPERATIONS.md",
    recommendation:
      "Update OPERATIONS.md with the affected deployment, health, rollback, recovery or runtime-operability behavior.",
  },
  {
    area: "testing",
    triggers: (path) => isCode(path),
    resolutionPaths: ["test/", "tests/", "__tests__/", "*.test.*", "*.spec.*"],
    resolves: (path) => isTest(path),
    recommendation:
      "Add or update automated tests that prove the changed behavior, or keep the change out of review until test impact is covered.",
  },
  {
    area: "task_graph",
    triggers: (path) => isPlanningDecision(path),
    resolutionPaths: [
      "TASKS.md",
      "docs/planning/ROADMAP.md",
      "docs/planning/dependency-graph.json",
    ],
    resolves: (path) =>
      path === "TASKS.md" ||
      path === "docs/planning/ROADMAP.md" ||
      path === "docs/planning/dependency-graph.json",
    recommendation:
      "Synchronize TASKS.md, ROADMAP.md or dependency-graph.json when a planning/ADR/operations decision changes implementation scope or dependencies.",
  },
];

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function hasLivingArchitectureBaseline(root: string): Promise<boolean> {
  return (
    (await exists(resolve(root, "docs", "planning", "APPROVED_PLAN.md"))) &&
    (await exists(resolve(root, "TASKS.md")))
  );
}

export async function analyzeArchitectureImpact(
  root: string,
  changedFileInput: readonly string[],
): Promise<ArchitectureImpactReport> {
  const changedFiles = [...new Set(changedFileInput.map(normalized))].filter(Boolean).sort();
  const baselineDetected = await hasLivingArchitectureBaseline(root);

  if (!baselineDetected) {
    return {
      baselineDetected: false,
      changedFiles,
      impacts: [],
      requiredCount: 0,
      unresolvedCount: 0,
      unresolvedAreas: [],
    };
  }

  const impacts = RULES.map((rule): ArchitectureImpactItem => {
    const reasons = changedFiles.filter(rule.triggers);
    const changedResolutionPaths = changedFiles.filter(rule.resolves);
    const required = reasons.length > 0;
    const resolved = !required || changedResolutionPaths.length > 0;

    return {
      area: rule.area,
      required,
      resolved,
      reasons,
      resolutionPaths: rule.resolutionPaths,
      changedResolutionPaths,
      recommendation: rule.recommendation,
    };
  }).filter((impact) => impact.required);

  const unresolved = impacts.filter((impact) => !impact.resolved);

  return {
    baselineDetected: true,
    changedFiles,
    impacts,
    requiredCount: impacts.length,
    unresolvedCount: unresolved.length,
    unresolvedAreas: unresolved.map((impact) => impact.area),
  };
}

export function architectureImpactSummary(report: ArchitectureImpactReport): string {
  if (!report.baselineDetected) {
    return "Living-architecture baseline not detected; no architecture synchronization gate was enforced.";
  }

  if (report.requiredCount === 0) {
    return "No material architecture/documentation impact was detected.";
  }

  if (report.unresolvedCount === 0) {
    return (
      "All " +
      report.requiredCount +
      " detected living-architecture impact area(s) have synchronization evidence."
    );
  }

  return (
    String(report.unresolvedCount) +
    " unresolved living-architecture impact area(s): " +
    report.unresolvedAreas.join(", ") +
    "."
  );
}
