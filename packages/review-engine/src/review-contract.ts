import { createHash } from "node:crypto";
import {
  activeRepositoryRules,
  type ConstitutionEntry,
  type RepositoryConstitution,
} from "@llmatic/repository-constitution";

export type ReviewRequirementKind =
  "acceptance_criterion" | "definition_of_done" | "pull_request_acceptance";

export interface ReviewTaskEvidence {
  provider: string;
  key: string;
  summary?: string;
  webUrl?: string;
  acceptanceCriteria: string[];
  definitionOfDone: string[];
}

export interface ReviewRequirementSource {
  kind: "task" | "pull_request" | "provided";
  provider?: string;
  reference?: string;
  label: string;
  url?: string;
}

export interface ReviewContractRequirement {
  id: string;
  kind: ReviewRequirementKind;
  text: string;
  referenceText: string;
  source: ReviewRequirementSource;
}

export interface ReviewContractRule {
  id: string;
  text: string;
  strength: ConstitutionEntry["strength"];
  scopes: string[];
  source: {
    path: string;
    line?: number;
  };
}

export interface ReviewContractInvariant {
  id: string;
  kind: "security" | "api" | "database" | "architecture";
  text: string;
  source: {
    path: string;
    line?: number;
  };
}

export interface ReviewContract {
  version: 1;
  headRefOid: string;
  task?: {
    provider: string;
    key: string;
    summary?: string;
    webUrl?: string;
  };
  requirements: ReviewContractRequirement[];
  rules: ReviewContractRule[];
  invariants: ReviewContractInvariant[];
  scopes: string[];
  requiredEvidence: string[];
  completeness: "complete" | "partial";
  warnings: string[];
}

export interface BuildReviewContractInput {
  headRefOid: string;
  title: string;
  body: string;
  changedFiles: string[];
  constitution: RepositoryConstitution;
  linkedTask?: ReviewTaskEvidence;
  supplementalAcceptanceEvidence?: string[];
  supplementalAcceptanceEvidenceSource?: string;
  acceptanceEvidenceUnavailableReason?: string;
}

const REVIEW_SCOPE_PATTERNS: Array<[RegExp, string]> = [
  [/\b(api|endpoint|route|http|openapi|api contract|route contract|http contract)\b/i, "api"],
  [/\b(db|database|schema|migration|sql|postgres|supabase|prisma)\b/i, "database"],
  [
    /\b(auth|authorization|authentication|security|rls|rbac|permission|secret|trust)\b/i,
    "security",
  ],
  [/\b(test|testing|spec|coverage|e2e|vitest|jest|playwright|regression)\b/i, "testing"],
  [/\b(ci|pipeline|github actions|workflow|lint|format|typecheck|build)\b/i, "quality"],
  [/\b(frontend|ui|ux|react|view|component)\b/i, "frontend"],
  [/\b(backend|server|service|worker|queue|job)\b/i, "backend"],
  [/\b(document|documentation|docs|readme|adr)\b/i, "documentation"],
  [/\b(task|jira|issue|roadmap|dod|definition of done|acceptance)\b/i, "task"],
  [/\b(git|branch|commit|pull request|pr|merge)\b/i, "delivery"],
  [/\b(architecture|architectural|boundary|module|layer)\b/i, "architecture"],
];

const GLOBAL_POLICY_SOURCE = /(?:^|\/)(?:agents?|contributing|code[-_]?review|review)\.md$/i;
const MAX_REVIEW_CONTRACT_RULES = 12;
const MAX_REVIEW_CONTRACT_INVARIANTS = 6;

const RULE_RELEVANCE_STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "must",
  "should",
  "this",
  "that",
  "into",
  "only",
  "when",
  "where",
  "without",
  "change",
  "changes",
  "pull",
  "request",
  "repository",
  "rule",
  "rules",
  "required",
  "existing",
  "current",
  "src",
  "docs",
  "doc",
  "lib",
  "app",
  "apps",
  "package",
  "packages",
  "feature",
  "features",
  "test",
  "tests",
  "spec",
  "index",
  "page",
  "component",
  "components",
  "file",
  "files",
  "module",
  "modules",
]);

const DISTINCTIVE_RULE_DOMAIN_GROUPS = [
  new Set(["admin", "administrator"]),
  new Set(["stripe", "payment", "billing"]),
  new Set(["map", "maps", "tile", "tiles", "gis", "postgis"]),
  new Set(["oauth", "otp", "session", "rbac"]),
  new Set(["cloudflare", "wrangler"]),
  new Set(["localization", "locale", "i18n"]),
  new Set(["github", "runner", "actions"]),
  new Set(["email", "webhook"]),
] as const;

function relevanceTerms(value: string): Set<string> {
  return new Set(
    value
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(
        (token) =>
          token.length >= 3 && !RULE_RELEVANCE_STOP_WORDS.has(token) && !/^\d+$/.test(token),
      ),
  );
}

function overlapCount(left: Set<string>, right: Set<string>): number {
  let count = 0;
  for (const item of left) {
    if (right.has(item)) count += 1;
  }
  return count;
}

function primaryReviewRelevanceTerms(input: BuildReviewContractInput): Set<string> {
  return relevanceTerms(
    [input.title, ...input.changedFiles, input.linkedTask?.summary ?? ""].join("\n"),
  );
}

function supportingReviewRelevanceTerms(
  input: BuildReviewContractInput,
  requirements: ReviewContractRequirement[],
): Set<string> {
  return relevanceTerms(
    [
      input.title,
      ...input.changedFiles,
      input.linkedTask?.summary ?? "",
      ...requirements.map((item) => item.text),
    ].join("\n"),
  );
}

function hasDistinctiveDomainMismatch(
  ruleTerms: Set<string>,
  primaryReviewTerms: Set<string>,
): boolean {
  for (const domain of DISTINCTIVE_RULE_DOMAIN_GROUPS) {
    const ruleUsesDomain = [...domain].some((term) => ruleTerms.has(term));
    if (!ruleUsesDomain) continue;
    const reviewUsesDomain = [...domain].some((term) => primaryReviewTerms.has(term));
    if (!reviewUsesDomain) return true;
  }
  return false;
}

function stableId(prefix: string, values: string[]): string {
  return (
    prefix +
    "-" +
    createHash("sha256").update(values.join("\u0000")).digest("hex").slice(0, 12).toUpperCase()
  );
}

function normalizedRequirement(value: string): string {
  return value
    .trim()
    .replace(/^[-*+]\s+/, "")
    .replace(/^\d+[.)]\s+/, "")
    .replace(/^\[[ xX]\]\s*/, "")
    .trim();
}

function pullRequestRequirements(body: string): string[] {
  const result: string[] = [];
  let active = false;

  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    const heading = line
      .match(/^#{1,6}\s+(.+)$/)?.[1]
      ?.trim()
      .toLowerCase();

    if (heading) {
      active = /\b(acceptance criteria|acceptance|definition of done|dod|done criteria|ac)\b/i.test(
        heading,
      );
      continue;
    }

    if (!active || !line) continue;
    if (!/^[-*+]\s+/.test(line) && !/^\d+[.)]\s+/.test(line)) continue;

    const item = normalizedRequirement(line);
    if (item) result.push(item);
  }

  return [...new Set(result)].slice(0, 100);
}

function requirement(
  kind: ReviewRequirementKind,
  text: string,
  source: ReviewRequirementSource,
  referenceText?: string,
): ReviewContractRequirement {
  const normalized = normalizedRequirement(text);
  return {
    id: stableId("REQ", [
      kind,
      source.kind,
      source.provider ?? "",
      source.reference ?? "",
      normalized.toLowerCase(),
    ]),
    kind,
    text: normalized,
    referenceText: referenceText ?? normalized,
    source,
  };
}

function buildRequirements(input: BuildReviewContractInput): ReviewContractRequirement[] {
  const result: ReviewContractRequirement[] = [];
  const task = input.linkedTask;

  if (task) {
    const source: ReviewRequirementSource = {
      kind: "task",
      provider: task.provider,
      reference: task.key,
      label: task.provider + " " + task.key,
      url: task.webUrl,
    };

    for (const item of task.acceptanceCriteria) {
      const text = normalizedRequirement(item);
      if (!text) continue;
      result.push(
        requirement(
          "acceptance_criterion",
          text,
          source,
          "[" + task.provider + " " + task.key + " AC] " + text,
        ),
      );
    }

    for (const item of task.definitionOfDone) {
      const text = normalizedRequirement(item);
      if (!text) continue;
      result.push(
        requirement(
          "definition_of_done",
          text,
          source,
          "[" + task.provider + " " + task.key + " DoD] " + text,
        ),
      );
    }
  }

  for (const item of input.supplementalAcceptanceEvidence ?? []) {
    const text = normalizedRequirement(item);
    if (!text) continue;
    result.push(
      requirement(
        "acceptance_criterion",
        text,
        {
          kind: "provided",
          label: input.supplementalAcceptanceEvidenceSource ?? "Provided acceptance evidence",
        },
        item.trim(),
      ),
    );
  }

  const prSource: ReviewRequirementSource = {
    kind: "pull_request",
    reference: input.headRefOid,
    label: "Pull request body",
  };
  for (const item of pullRequestRequirements(input.body)) {
    result.push(requirement("pull_request_acceptance", item, prSource));
  }

  const byIdentity = new Map<string, ReviewContractRequirement>();
  for (const item of result) {
    const identity = item.kind + "\u0000" + item.text.toLowerCase();
    if (!byIdentity.has(identity)) byIdentity.set(identity, item);
  }

  return [...byIdentity.values()].slice(0, 100);
}

function scopesFromText(haystack: string): string[] {
  const scopes = new Set<string>();
  for (const [pattern, scope] of REVIEW_SCOPE_PATTERNS) {
    if (pattern.test(haystack)) scopes.add(scope);
  }
  if (scopes.size === 0) scopes.add("repository");
  return [...scopes].sort();
}

function inferredScopes(
  input: BuildReviewContractInput,
  requirements: ReviewContractRequirement[],
): string[] {
  return scopesFromText(
    [
      input.title,
      input.body,
      ...input.changedFiles,
      ...requirements.map((item) => item.text),
      input.linkedTask?.summary ?? "",
    ].join("\n"),
  );
}

function primaryRuleScopes(input: BuildReviewContractInput): string[] {
  return scopesFromText(
    [input.title, ...input.changedFiles, input.linkedTask?.summary ?? ""].join("\n"),
  );
}

function selectedRules(
  constitution: RepositoryConstitution,
  scopes: string[],
  primaryReviewTerms: Set<string>,
  supportingReviewTerms: Set<string>,
): ReviewContractRule[] {
  const scopeSet = new Set(scopes);
  const ranked = activeRepositoryRules(constitution)
    .map((rule) => {
      const scopeOverlap = rule.scopes.filter((scope) => scopeSet.has(scope)).length;
      const repositoryScoped = rule.scopes.includes("repository");
      const globalPolicy = GLOBAL_POLICY_SOURCE.test(rule.source.path);
      const ruleTextTerms = relevanceTerms(rule.text);
      const ruleSourceTerms = relevanceTerms(rule.source.path);
      const ruleTerms = new Set([...ruleTextTerms, ...ruleSourceTerms]);
      const lexicalOverlap = overlapCount(ruleTerms, supportingReviewTerms);
      const primaryOverlap = overlapCount(ruleTerms, primaryReviewTerms);
      const textPrimaryOverlap = overlapCount(ruleTextTerms, primaryReviewTerms);
      const sourcePrimaryOverlap = overlapCount(ruleSourceTerms, primaryReviewTerms);
      const domainMismatch = hasDistinctiveDomainMismatch(ruleTerms, primaryReviewTerms);
      const criticalPrimaryScope = rule.scopes.some(
        (scope) =>
          scopeSet.has(scope) && (scope === "security" || scope === "database" || scope === "api"),
      );
      const sourcePriority = globalPolicy ? 20 : 0;
      const score =
        (rule.strength === "blocking" ? 100 : rule.strength === "advisory" ? 50 : 10) +
        scopeOverlap * 50 +
        Math.min(lexicalOverlap, 6) * 20 +
        sourcePriority;

      return {
        rule,
        scopeOverlap,
        repositoryScoped,
        globalPolicy,
        lexicalOverlap,
        primaryOverlap,
        textPrimaryOverlap,
        sourcePrimaryOverlap,
        domainMismatch,
        criticalPrimaryScope,
        score,
      };
    })
    .filter(
      ({
        scopeOverlap,
        repositoryScoped,
        globalPolicy,
        lexicalOverlap,
        primaryOverlap,
        textPrimaryOverlap,
        sourcePrimaryOverlap,
        domainMismatch,
        criticalPrimaryScope,
      }) => {
        if (domainMismatch) return false;
        if (globalPolicy) return primaryOverlap >= 2;
        if (scopeOverlap > 0) {
          return (
            textPrimaryOverlap >= 2 ||
            (criticalPrimaryScope && textPrimaryOverlap >= 1) ||
            (textPrimaryOverlap >= 1 && sourcePrimaryOverlap >= 1)
          );
        }
        if (primaryOverlap >= 3 && lexicalOverlap >= 3) return true;
        return repositoryScoped && textPrimaryOverlap >= 2;
      },
    )
    .sort(
      (left, right) =>
        right.score - left.score ||
        right.lexicalOverlap - left.lexicalOverlap ||
        left.rule.source.path.localeCompare(right.rule.source.path) ||
        left.rule.id.localeCompare(right.rule.id),
    )
    .slice(0, MAX_REVIEW_CONTRACT_RULES);

  return ranked.map(({ rule }) => ({
    id: rule.id,
    text: rule.text,
    strength: rule.strength,
    scopes: rule.scopes,
    source: {
      path: rule.source.path,
      line: rule.source.line,
    },
  }));
}

function selectedInvariants(rules: ReviewContractRule[]): ReviewContractInvariant[] {
  const result: ReviewContractInvariant[] = [];
  for (const rule of rules) {
    const kinds = [
      rule.scopes.includes("security") ? ("security" as const) : undefined,
      rule.scopes.includes("api") ? ("api" as const) : undefined,
      rule.scopes.includes("database") ? ("database" as const) : undefined,
      rule.scopes.includes("architecture") ? ("architecture" as const) : undefined,
    ].filter((value): value is ReviewContractInvariant["kind"] => Boolean(value));

    for (const kind of kinds) {
      result.push({
        id: stableId("INV", [rule.id, kind]),
        kind,
        text: rule.text,
        source: rule.source,
      });
    }
  }

  return result.slice(0, MAX_REVIEW_CONTRACT_INVARIANTS);
}

function requiredEvidence(scopes: string[], requirements: ReviewContractRequirement[]): string[] {
  const result = new Set<string>(["implementation"]);
  const haystack = requirements.map((item) => item.text).join("\n");

  if (scopes.includes("testing") || /\b(test|tests|coverage|regression)\b/i.test(haystack)) {
    result.add("tests");
  }
  if (scopes.includes("documentation") || /\b(documentation|docs|readme|adr)\b/i.test(haystack)) {
    result.add("documentation");
  }
  if (scopes.includes("security")) result.add("security");
  if (scopes.includes("api")) result.add("api_contract");
  if (scopes.includes("database")) result.add("database_schema");
  if (scopes.includes("quality")) result.add("quality_gates");

  return [...result];
}

export function buildReviewContract(input: BuildReviewContractInput): ReviewContract {
  const requirements = buildRequirements(input);
  const scopes = inferredScopes(input, requirements);
  const rules = selectedRules(
    input.constitution,
    primaryRuleScopes(input),
    primaryReviewRelevanceTerms(input),
    supportingReviewRelevanceTerms(input, requirements),
  );
  const warnings: string[] = [];

  if (input.acceptanceEvidenceUnavailableReason) {
    warnings.push(input.acceptanceEvidenceUnavailableReason);
  }
  if (input.linkedTask && requirements.every((item) => item.source.kind !== "task")) {
    warnings.push(
      input.linkedTask.provider +
        " " +
        input.linkedTask.key +
        " has no explicit acceptance criteria or Definition of Done.",
    );
  }

  return {
    version: 1,
    headRefOid: input.headRefOid,
    task: input.linkedTask
      ? {
          provider: input.linkedTask.provider,
          key: input.linkedTask.key,
          summary: input.linkedTask.summary,
          webUrl: input.linkedTask.webUrl,
        }
      : undefined,
    requirements,
    rules,
    invariants: selectedInvariants(rules),
    scopes,
    requiredEvidence: requiredEvidence(scopes, requirements),
    completeness: input.acceptanceEvidenceUnavailableReason ? "partial" : "complete",
    warnings,
  };
}

export function reviewContractAcceptanceEvidence(contract: ReviewContract): string[] {
  return contract.requirements.map((item) => item.referenceText);
}

export function reviewContractPolicyContext(contract: ReviewContract): string {
  const lines = [
    "Review Contract (authoritative normalized review evidence):",
    "- Exact head: " + contract.headRefOid,
    "- Completeness: " + contract.completeness,
    "- Scopes: " + contract.scopes.join(", "),
    "- Required evidence: " + contract.requiredEvidence.join(", "),
    contract.task
      ? "- Task: " +
        contract.task.provider +
        " " +
        contract.task.key +
        (contract.task.summary ? " — " + contract.task.summary : "")
      : "- Task: none resolved",
    "- Requirements: " + String(contract.requirements.length),
    ...contract.requirements.map(
      (item) =>
        "  - " +
        item.id +
        " [" +
        item.kind +
        "] " +
        item.referenceText +
        " (source " +
        item.source.label +
        ")",
    ),
    "- Relevant repository rules: " + String(contract.rules.length),
    ...contract.rules.map(
      (rule) =>
        "  - " +
        rule.id +
        " [" +
        rule.strength +
        "] " +
        rule.text +
        " (source " +
        rule.source.path +
        (rule.source.line ? ":" + rule.source.line : "") +
        "; scopes " +
        rule.scopes.join(",") +
        ")",
    ),
    "- Applicable invariants: " + String(contract.invariants.length),
    ...contract.invariants.map(
      (invariant) =>
        "  - " +
        invariant.id +
        " [" +
        invariant.kind +
        "] " +
        invariant.text +
        " (source " +
        invariant.source.path +
        (invariant.source.line ? ":" + invariant.source.line : "") +
        ")",
    ),
    ...contract.warnings.map((warning) => "- WARNING: " + warning),
  ];

  return lines.join("\n");
}
