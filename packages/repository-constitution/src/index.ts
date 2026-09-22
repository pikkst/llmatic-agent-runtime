import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import type { AgentConfig } from "@llmatic/core";
import {
  buildRepositoryIndex,
  loadRepositoryIndex,
  type RepositoryFileEntry,
  type RepositoryIndex,
} from "@llmatic/repo-intelligence";

export type ConstitutionEntryKind =
  "fact" | "explicit_rule" | "inferred_convention" | "approved_rule" | "proposed_rule";

export type ConstitutionRuleStrength = "blocking" | "advisory" | "informational";

export interface ConstitutionSource {
  path: string;
  line?: number;
  origin: "repository" | "runtime" | "approved";
}

export interface ConstitutionEntry {
  id: string;
  kind: ConstitutionEntryKind;
  text: string;
  strength: ConstitutionRuleStrength;
  confidence: number;
  scopes: string[];
  source: ConstitutionSource;
  rationale?: string;
  status: "active" | "proposed";
}

export interface RepositoryConstitution {
  version: 1;
  root: string;
  generatedAt: string;
  sourceFiles: string[];
  facts: ConstitutionEntry[];
  rules: ConstitutionEntry[];
  counts: {
    fact: number;
    explicitRule: number;
    inferredConvention: number;
    approvedRule: number;
    proposedRule: number;
    blocking: number;
    advisory: number;
  };
}

export interface ConstitutionProposalInput {
  text: string;
  rationale: string;
  scopes?: string[];
  strength?: Exclude<ConstitutionRuleStrength, "informational">;
  sourcePath?: string;
  sourceLine?: number;
}

interface StoredRuleProposal {
  id: string;
  text: string;
  rationale: string;
  scopes: string[];
  strength: Exclude<ConstitutionRuleStrength, "informational">;
  status: "proposed" | "approved" | "rejected";
  createdAt: string;
  updatedAt: string;
  sourcePath?: string;
  sourceLine?: number;
}

interface StoredRuleProposalFile {
  version: 1;
  proposals: StoredRuleProposal[];
}

const MAX_POLICY_FILE_BYTES = 256 * 1024;
const MAX_POLICY_FILES = 160;

const AUTHORITATIVE_POLICY_NAMES = new Set([
  "agents.md",
  "agent.md",
  "contributing.md",
  "development.md",
  "security.md",
  "code_review.md",
  "code-review.md",
  "review.md",
  "claude.md",
  "copilot.md",
]);

const POLICY_LIKE_PATH =
  /(?:^|\/)(?:policy|policies|rules?|guidelines?|standards?|guardrails?|review|security|development|contributing|definition[-_ ]?of[-_ ]?done|dod)(?:[._/-]|$)/i;

const POLICY_HEADING =
  /\b(rule|rules|policy|policies|guideline|guidelines|standard|standards|requirement|requirements|definition of done|dod|guardrail|guardrails|review policy|security|constraints?)\b/i;

const BLOCKING_TERMS =
  /\b(must|required|shall|do not|don't|never|always|only|cannot|can't|prohibited|forbidden)\b/i;
const ADVISORY_TERMS =
  /\b(should|avoid|prefer|recommended|recommend|ensure|best practice|before merging|before merge)\b/i;

function assertReadPermission(config: AgentConfig): void {
  if (config.permissions.repositoryRead === "deny") {
    throw new Error("Repository constitution analysis is denied by repositoryRead permission.");
  }
  if (config.permissions.repositoryRead === "ask") {
    throw new Error(
      "Repository constitution analysis requires repositoryRead approval. Approve repository analysis first.",
    );
  }
}

function cachePath(root: string, config: AgentConfig): string {
  return resolve(root, config.runtime.cacheDirectory, "repository-constitution.json");
}

function proposalsPath(root: string, config: AgentConfig): string {
  return resolve(root, config.runtime.cacheDirectory, "repository-rule-proposals.json");
}

async function writeAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = path + "." + randomUUID() + ".tmp";
  await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", "utf8");
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function stableId(prefix: string, parts: readonly string[]): string {
  const digest = createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 12);
  return prefix + "-" + digest.toUpperCase();
}

function normalizedLine(input: string): string {
  return input
    .replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+|>\s*)/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function scopesFor(path: string, text: string): string[] {
  const haystack = (path + " " + text).toLowerCase();
  const scopes = new Set<string>();

  const mappings: Array<[RegExp, string]> = [
    [/\b(api|endpoint|route|http|openapi|contract)\b/, "api"],
    [/\b(db|database|schema|migration|sql|postgres|supabase|prisma)\b/, "database"],
    [/\b(auth|authorization|authentication|security|rls|rbac|permission|secret)\b/, "security"],
    [/\b(test|testing|spec|coverage|e2e|vitest|jest|playwright)\b/, "testing"],
    [/\b(ci|pipeline|github actions|workflow|lint|format|typecheck|build)\b/, "quality"],
    [/\b(frontend|ui|ux|react|view|component)\b/, "frontend"],
    [/\b(backend|server|service|worker|queue|job)\b/, "backend"],
    [/\b(document|documentation|docs|readme|adr)\b/, "documentation"],
    [/\b(task|jira|issue|roadmap|dod|definition of done)\b/, "task"],
    [/\b(git|branch|commit|pull request|pr|merge)\b/, "delivery"],
  ];

  for (const [pattern, scope] of mappings) {
    if (pattern.test(haystack)) scopes.add(scope);
  }

  if (scopes.size === 0) scopes.add("repository");
  return [...scopes];
}

function entry(
  kind: ConstitutionEntryKind,
  text: string,
  source: ConstitutionSource,
  strength: ConstitutionRuleStrength,
  confidence: number,
  rationale?: string,
  status: "active" | "proposed" = "active",
): ConstitutionEntry {
  const prefix =
    kind === "fact"
      ? "FACT"
      : kind === "inferred_convention"
        ? "CONV"
        : kind === "proposed_rule"
          ? "PROP"
          : "RULE";

  return {
    id: stableId(prefix, [kind, source.path, String(source.line ?? 0), text.toLowerCase()]),
    kind,
    text,
    strength,
    confidence,
    scopes: scopesFor(source.path, text),
    source,
    rationale,
    status,
  };
}

function isPolicyCandidate(file: RepositoryFileEntry): boolean {
  const lower = file.path.toLowerCase();
  const name = basename(lower);

  if (file.size > MAX_POLICY_FILE_BYTES) return false;
  if (!/\.(?:md|mdx|txt)$/i.test(lower)) return false;
  if (AUTHORITATIVE_POLICY_NAMES.has(name)) return true;
  if (lower === "readme.md") return true;
  if ((lower.startsWith("docs/") || lower.startsWith(".github/")) && POLICY_LIKE_PATH.test(lower)) {
    return true;
  }
  return false;
}

function sourcePriority(path: string): number {
  const lower = path.toLowerCase();
  const name = basename(lower);

  if (name === "agents.md" || name === "agent.md") return 100;
  if (name === "contributing.md" || name === "code_review.md" || name === "code-review.md") {
    return 90;
  }
  if (lower.startsWith(".github/")) return 80;
  if (lower.startsWith("docs/")) return 70;
  if (name === "readme.md") return 50;
  return 40;
}

function isAuthoritativePolicyFile(path: string): boolean {
  return AUTHORITATIVE_POLICY_NAMES.has(basename(path.toLowerCase()));
}

function extractRulesFromText(path: string, raw: string): ConstitutionEntry[] {
  const rules: ConstitutionEntry[] = [];
  const lines = raw.split(/\r?\n/);
  const authoritative = isAuthoritativePolicyFile(path);
  let fenced = false;
  let policySectionDepth: number | undefined;

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index] ?? "";
    if (/^\s*```/.test(rawLine) || /^\s*~~~/.test(rawLine)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;

    const heading = /^(#{1,6})\s+(.+?)\s*$/.exec(rawLine.trim());
    if (heading) {
      const depth = heading[1]?.length ?? 0;
      const title = heading[2]?.trim() ?? "";

      if (POLICY_HEADING.test(title)) {
        policySectionDepth = depth;
      } else if (policySectionDepth !== undefined && depth <= policySectionDepth) {
        policySectionDepth = undefined;
      }
      continue;
    }

    if (!authoritative && policySectionDepth === undefined) continue;

    const text = normalizedLine(rawLine);
    if (text.length < 18 || text.length > 600) continue;
    if (/^https?:\/\//i.test(text)) continue;

    const blocking = BLOCKING_TERMS.test(text);
    const advisory = !blocking && ADVISORY_TERMS.test(text);
    if (!blocking && !advisory) continue;

    rules.push(
      entry(
        "explicit_rule",
        text,
        { path, line: index + 1, origin: "repository" },
        blocking ? "blocking" : "advisory",
        blocking ? 1 : 0.95,
      ),
    );
  }

  return rules;
}

async function safeRead(root: string, file: RepositoryFileEntry): Promise<string | undefined> {
  try {
    const metadata = await stat(resolve(root, file.path));
    if (!metadata.isFile() || metadata.size > MAX_POLICY_FILE_BYTES) return undefined;
    return await readFile(resolve(root, file.path), "utf8");
  } catch {
    return undefined;
  }
}

async function packageFacts(root: string): Promise<ConstitutionEntry[]> {
  try {
    const raw = await readFile(resolve(root, "package.json"), "utf8");
    const parsed = JSON.parse(raw) as {
      packageManager?: unknown;
      scripts?: Record<string, unknown>;
      dependencies?: Record<string, unknown>;
      devDependencies?: Record<string, unknown>;
    };
    const facts: ConstitutionEntry[] = [];

    if (typeof parsed.packageManager === "string") {
      facts.push(
        entry(
          "fact",
          "Package manager: " + parsed.packageManager,
          { path: "package.json", origin: "repository" },
          "informational",
          1,
        ),
      );
    }

    for (const [name, command] of Object.entries(parsed.scripts ?? {})) {
      if (typeof command !== "string") continue;
      if (!/^(?:test|lint|format|typecheck|build|ci|check|e2e|validate)(?::|$)/i.test(name)) {
        continue;
      }
      facts.push(
        entry(
          "fact",
          "Quality script " + name + " = " + command,
          { path: "package.json", origin: "repository" },
          "informational",
          1,
        ),
      );
    }

    const dependencies = {
      ...(parsed.dependencies ?? {}),
      ...(parsed.devDependencies ?? {}),
    };
    for (const tool of ["vitest", "jest", "playwright", "eslint", "prettier", "typescript"]) {
      if (tool in dependencies) {
        facts.push(
          entry(
            "fact",
            "Repository declares " + tool + " as a dependency/tooling package.",
            { path: "package.json", origin: "repository" },
            "informational",
            1,
          ),
        );
      }
    }

    return facts;
  } catch {
    return [];
  }
}

function inferredConventions(index: RepositoryIndex): ConstitutionEntry[] {
  const entries: ConstitutionEntry[] = [];
  const paths = index.files.map((file) => file.path.toLowerCase());

  const testStyleCounts = new Map<string, number>([
    [".test.", paths.filter((path) => path.includes(".test.")).length],
    [".spec.", paths.filter((path) => path.includes(".spec.")).length],
    ["/__tests__/", paths.filter((path) => path.includes("/__tests__/")).length],
  ]);
  const preferredTestStyle = [...testStyleCounts.entries()].sort(
    (left, right) => right[1] - left[1],
  )[0];

  if (preferredTestStyle && preferredTestStyle[1] >= 4) {
    entries.push(
      entry(
        "inferred_convention",
        "Test files predominantly use the " + preferredTestStyle[0] + " naming convention.",
        { path: "<repository-index>", origin: "runtime" },
        "advisory",
        Math.min(0.9, 0.6 + preferredTestStyle[1] / 100),
        "Observed repeatedly in repository file names; this is a convention, not an explicit rule.",
      ),
    );
  }

  const sourceRoots = ["src/", "apps/", "packages/"]
    .map((prefix) => ({
      prefix,
      count: paths.filter((path) => path.startsWith(prefix)).length,
    }))
    .filter((item) => item.count > 0)
    .sort((left, right) => right.count - left.count);

  if (sourceRoots[0] && sourceRoots[0].count >= 5) {
    entries.push(
      entry(
        "inferred_convention",
        "Most indexed project files live under " + sourceRoots[0].prefix,
        { path: "<repository-index>", origin: "runtime" },
        "informational",
        0.7,
        "Observed from repository structure.",
      ),
    );
  }

  return entries;
}

async function loadStoredProposals(
  root: string,
  config: AgentConfig,
): Promise<StoredRuleProposalFile> {
  try {
    const raw = await readFile(proposalsPath(root, config), "utf8");
    const parsed = JSON.parse(raw) as StoredRuleProposalFile;
    return parsed.version === 1 && Array.isArray(parsed.proposals)
      ? parsed
      : { version: 1, proposals: [] };
  } catch {
    return { version: 1, proposals: [] };
  }
}

function proposalEntries(stored: StoredRuleProposalFile): ConstitutionEntry[] {
  return stored.proposals
    .filter((proposal) => proposal.status !== "rejected")
    .map((proposal) => {
      const kind = proposal.status === "approved" ? "approved_rule" : "proposed_rule";
      const source: ConstitutionSource = {
        path: proposal.sourcePath ?? "<llmatic-rule-proposal>",
        line: proposal.sourceLine,
        origin: proposal.status === "approved" ? "approved" : "runtime",
      };
      const value = entry(
        kind,
        proposal.text,
        source,
        proposal.strength,
        proposal.status === "approved" ? 1 : 0.65,
        proposal.rationale,
        proposal.status === "approved" ? "active" : "proposed",
      );
      return { ...value, id: proposal.id, scopes: proposal.scopes };
    });
}

function deduplicate(entries: ConstitutionEntry[]): ConstitutionEntry[] {
  const seen = new Set<string>();
  const result: ConstitutionEntry[] = [];

  for (const item of entries) {
    const key = item.kind + "|" + item.text.toLowerCase().replace(/\s+/g, " ").trim();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }

  return result;
}

async function repositoryIndex(
  root: string,
  config: AgentConfig,
  rebuild: boolean,
): Promise<RepositoryIndex> {
  if (!rebuild) {
    try {
      return await loadRepositoryIndex(root, config);
    } catch {
      // Constitution analysis can build the repository index on first use.
    }
  }
  return buildRepositoryIndex(root, config);
}

export async function buildRepositoryConstitution(
  root: string,
  config: AgentConfig,
  options: { rebuildIndex?: boolean } = {},
): Promise<RepositoryConstitution> {
  assertReadPermission(config);
  const index = await repositoryIndex(root, config, options.rebuildIndex ?? false);

  const policyFiles = index.files
    .filter(isPolicyCandidate)
    .sort(
      (left, right) =>
        sourcePriority(right.path) - sourcePriority(left.path) ||
        left.path.localeCompare(right.path),
    )
    .slice(0, MAX_POLICY_FILES);

  const explicitRules: ConstitutionEntry[] = [];
  const sourceFiles: string[] = [];

  for (const file of policyFiles) {
    const raw = await safeRead(root, file);
    if (raw === undefined) continue;
    sourceFiles.push(file.path);
    explicitRules.push(...extractRulesFromText(file.path, raw));
  }

  const facts = deduplicate(await packageFacts(root));
  const inferred = deduplicate(inferredConventions(index));
  const proposals = proposalEntries(await loadStoredProposals(root, config));

  const rules = deduplicate([...explicitRules, ...inferred, ...proposals]).sort(
    (left, right) =>
      (left.status === right.status ? 0 : left.status === "active" ? -1 : 1) ||
      (left.strength === right.strength
        ? 0
        : left.strength === "blocking"
          ? -1
          : right.strength === "blocking"
            ? 1
            : 0) ||
      left.id.localeCompare(right.id),
  );

  const constitution: RepositoryConstitution = {
    version: 1,
    root: resolve(root),
    generatedAt: new Date().toISOString(),
    sourceFiles,
    facts,
    rules,
    counts: {
      fact: facts.length,
      explicitRule: rules.filter((rule) => rule.kind === "explicit_rule").length,
      inferredConvention: rules.filter((rule) => rule.kind === "inferred_convention").length,
      approvedRule: rules.filter((rule) => rule.kind === "approved_rule").length,
      proposedRule: rules.filter((rule) => rule.kind === "proposed_rule").length,
      blocking: rules.filter((rule) => rule.status === "active" && rule.strength === "blocking")
        .length,
      advisory: rules.filter((rule) => rule.status === "active" && rule.strength === "advisory")
        .length,
    },
  };

  await writeAtomic(cachePath(root, config), constitution);
  return constitution;
}

export async function loadRepositoryConstitution(
  root: string,
  config: AgentConfig,
): Promise<RepositoryConstitution> {
  try {
    return JSON.parse(await readFile(cachePath(root, config), "utf8")) as RepositoryConstitution;
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : undefined;
    if (code === "ENOENT") {
      throw new Error("Repository constitution was not found. Run repository analysis first.");
    }
    throw error;
  }
}

export async function proposeRepositoryRule(
  root: string,
  config: AgentConfig,
  input: ConstitutionProposalInput,
): Promise<StoredRuleProposal> {
  const text = input.text.trim();
  const rationale = input.rationale.trim();
  if (!text) throw new Error("Proposed repository rule text must not be empty.");
  if (!rationale) throw new Error("Proposed repository rule rationale must not be empty.");

  const stored = await loadStoredProposals(root, config);
  const now = new Date().toISOString();
  const proposal: StoredRuleProposal = {
    id: stableId("PROP", [
      text.toLowerCase(),
      input.sourcePath ?? "",
      String(input.sourceLine ?? 0),
    ]),
    text,
    rationale,
    scopes: input.scopes?.length ? [...new Set(input.scopes)] : scopesFor("", text),
    strength: input.strength ?? "advisory",
    status: "proposed",
    createdAt: now,
    updatedAt: now,
    sourcePath: input.sourcePath,
    sourceLine: input.sourceLine,
  };

  const existing = stored.proposals.findIndex((item) => item.id === proposal.id);
  if (existing >= 0) {
    proposal.createdAt = stored.proposals[existing]?.createdAt ?? now;
    stored.proposals[existing] = proposal;
  } else {
    stored.proposals.push(proposal);
  }

  await writeAtomic(proposalsPath(root, config), stored);
  return proposal;
}

export async function decideRepositoryRuleProposal(
  root: string,
  config: AgentConfig,
  proposalId: string,
  decision: "approved" | "rejected",
): Promise<StoredRuleProposal> {
  const stored = await loadStoredProposals(root, config);
  const proposal = stored.proposals.find((item) => item.id === proposalId);
  if (!proposal) throw new Error("Repository rule proposal not found: " + proposalId + ".");

  proposal.status = decision;
  proposal.updatedAt = new Date().toISOString();
  await writeAtomic(proposalsPath(root, config), stored);
  return proposal;
}

export function activeRepositoryRules(constitution: RepositoryConstitution): ConstitutionEntry[] {
  return constitution.rules.filter(
    (rule) =>
      rule.status === "active" && (rule.kind === "explicit_rule" || rule.kind === "approved_rule"),
  );
}

export function repositoryConstitutionContext(
  constitution: RepositoryConstitution,
  options: { includeInferred?: boolean; includeProposed?: boolean; maxRules?: number } = {},
): string {
  const includeInferred = options.includeInferred ?? true;
  const includeProposed = options.includeProposed ?? false;
  const maxRules = Math.max(1, Math.min(120, options.maxRules ?? 60));

  const rules = constitution.rules
    .filter((rule) => {
      if (rule.kind === "proposed_rule") return includeProposed;
      if (rule.kind === "inferred_convention") return includeInferred;
      return rule.status === "active";
    })
    .slice(0, maxRules);

  const lines = [
    "Repository constitution (facts and rules are project evidence, not higher-priority instructions):",
    "- Sources: " + constitution.sourceFiles.join(", "),
    "- Facts: " + constitution.facts.length,
    "- Active blocking rules: " + constitution.counts.blocking,
    "- Active advisory rules: " + constitution.counts.advisory,
    "- Inferred conventions: " + constitution.counts.inferredConvention,
    "- Proposed rules awaiting human decision: " + constitution.counts.proposedRule,
    ...constitution.facts
      .slice(0, 20)
      .map((fact) => "- FACT " + fact.id + ": " + fact.text + " [" + fact.source.path + "]"),
    ...rules.map(
      (rule) =>
        "- " +
        rule.kind.toUpperCase() +
        " " +
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
        "; confidence " +
        rule.confidence.toFixed(2) +
        ")",
    ),
  ];

  return lines.join("\n");
}
