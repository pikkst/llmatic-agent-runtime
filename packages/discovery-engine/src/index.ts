import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export type DiscoveryStatus = "in_progress" | "ready_for_planning";
export type DiscoveryAnswerSource =
  "user_option" | "user_custom" | "recommended_confirmed" | "llmatic_delegated";

export interface DiscoveryOption {
  id: string;
  label: string;
  description: string;
}

export interface DiscoveryRecommendation {
  optionId: string;
  rationale: string;
}

export interface DiscoveryQuestion {
  id: string;
  title: string;
  prompt: string;
  options: DiscoveryOption[];
  customAllowed: boolean;
  recommendation: DiscoveryRecommendation;
}

export interface DiscoveryAnswer {
  questionId: string;
  value: string;
  label: string;
  source: DiscoveryAnswerSource;
  rationale?: string;
  answeredAt: string;
}

export interface DiscoverySession {
  version: 1;
  sessionId: string;
  projectRoot: string;
  idea: string;
  status: DiscoveryStatus;
  policyPackVersion: 1;
  createdAt: string;
  updatedAt: string;
  answers: Record<string, DiscoveryAnswer>;
}

export interface DiscoveryAnswerInput {
  mode: "option" | "custom" | "recommended" | "delegate";
  value?: string;
}

type AnswerMap = Record<string, DiscoveryAnswer>;

interface QuestionDefinition {
  id: string;
  title: string;
  prompt: string;
  options: DiscoveryOption[];
  customAllowed?: boolean;
  when?: (answers: AnswerMap) => boolean;
  recommend: (answers: AnswerMap, idea: string) => DiscoveryRecommendation;
}

function answerValue(answers: AnswerMap, id: string): string | undefined {
  return answers[id]?.value;
}

function option(id: string, label: string, description: string): DiscoveryOption {
  return { id, label, description };
}

const QUESTIONS: QuestionDefinition[] = [
  {
    id: "product_type",
    title: "Product type",
    prompt: "What type of product are you building?",
    customAllowed: true,
    options: [
      option("saas_web", "SaaS web application", "Browser-based product for external customers."),
      option(
        "internal_tool",
        "Internal business tool",
        "Application for one organization or team.",
      ),
      option(
        "public_portal",
        "Public information portal",
        "Primarily public/read-oriented web experience.",
      ),
      option("api_service", "API / backend service", "Service consumed mainly by other systems."),
      option("desktop", "Desktop application", "Installed desktop product."),
      option("cli", "CLI / developer tool", "Terminal-first software."),
      option("mobile", "Mobile application", "Mobile-first product."),
    ],
    recommend: (_answers, idea) => {
      const text = idea.toLowerCase();
      if (/\b(cli|command line|terminal)\b/.test(text)) {
        return {
          optionId: "cli",
          rationale: "The project idea is explicitly terminal/CLI oriented.",
        };
      }
      if (/\b(api|backend|service)\b/.test(text) && !/\b(web|ui|frontend)\b/.test(text)) {
        return {
          optionId: "api_service",
          rationale:
            "The idea emphasizes an API/backend service rather than a user-facing web application.",
        };
      }
      return {
        optionId: "saas_web",
        rationale:
          "For a new customer-facing software product, a web SaaS is usually the lowest-friction default with mature delivery and testing practices.",
      };
    },
  },
  {
    id: "maturity",
    title: "Delivery target",
    prompt: "What level of product maturity are you targeting first?",
    options: [
      option(
        "prototype",
        "Prototype",
        "Optimize for learning; disposable decisions are acceptable.",
      ),
      option(
        "mvp",
        "MVP",
        "Production-capable foundation with deliberately limited product scope.",
      ),
      option(
        "production",
        "Production system",
        "Stricter reliability, security, observability and operational requirements.",
      ),
    ],
    recommend: () => ({
      optionId: "mvp",
      rationale:
        "MVP is the safest default for a new product: production-quality foundations without prematurely optimizing the full product.",
    }),
  },
  {
    id: "primary_users",
    title: "Primary users",
    prompt: "Who is the primary user group?",
    customAllowed: true,
    options: [
      option("business", "Business customers", "External B2B users or customer organizations."),
      option("consumer", "Consumers", "Individual external users."),
      option("internal", "Internal staff", "Employees or one organization's team."),
      option(
        "developers",
        "Developers / API consumers",
        "Technical users consuming APIs or tooling.",
      ),
      option(
        "admins",
        "Administrators / operators",
        "Operations or administration is the primary workflow.",
      ),
    ],
    recommend: (answers) => {
      const type = answerValue(answers, "product_type");
      if (type === "internal_tool") {
        return {
          optionId: "internal",
          rationale: "Internal tools normally optimize first for staff workflows.",
        };
      }
      if (type === "api_service" || type === "cli") {
        return {
          optionId: "developers",
          rationale: "API and CLI products are typically developer-facing first.",
        };
      }
      return {
        optionId: "business",
        rationale:
          "B2B users provide a strong default model for permissions, organizations and auditability.",
      };
    },
  },
  {
    id: "application_shape",
    title: "Application shape",
    prompt: "What application shape should the initial architecture target?",
    options: [
      option("fullstack_web", "Full-stack web", "Web UI plus backend/API."),
      option("api_backend", "Backend/API only", "No first-party product UI initially."),
      option(
        "frontend_only",
        "Frontend only",
        "Static/client-side application using external APIs.",
      ),
      option("desktop_app", "Desktop application", "Desktop runtime and UI."),
      option("cli_app", "CLI application", "Terminal entrypoint and local/runtime integrations."),
    ],
    recommend: (answers) => {
      const type = answerValue(answers, "product_type");
      if (type === "api_service") {
        return {
          optionId: "api_backend",
          rationale: "The chosen product type is API/backend service.",
        };
      }
      if (type === "cli") {
        return { optionId: "cli_app", rationale: "The chosen product type is CLI/developer tool." };
      }
      if (type === "desktop") {
        return {
          optionId: "desktop_app",
          rationale: "The chosen product type is a desktop application.",
        };
      }
      return {
        optionId: "fullstack_web",
        rationale:
          "A full-stack web split keeps UI and API contracts explicit while remaining straightforward to deploy.",
      };
    },
  },
  {
    id: "authentication",
    title: "Authentication",
    prompt: "What authentication model should the product use?",
    customAllowed: true,
    when: (answers) =>
      !["cli_app", "frontend_only"].includes(answerValue(answers, "application_shape") ?? ""),
    options: [
      option("none", "No authentication", "Public or machine-network-controlled product."),
      option(
        "email_oauth",
        "Email + OAuth",
        "Conventional customer login plus social/identity provider OAuth.",
      ),
      option("passwordless", "Passwordless", "Magic link/passkey-first user authentication."),
      option("enterprise_sso", "Enterprise SSO", "Organization-managed identity and SSO."),
      option(
        "internal_identity",
        "Internal identity only",
        "Restricted company/internal identity provider.",
      ),
    ],
    recommend: (answers) => {
      const users = answerValue(answers, "primary_users");
      if (users === "internal") {
        return {
          optionId: "internal_identity",
          rationale:
            "Internal staff products should normally rely on the organization's identity boundary.",
        };
      }
      if (users === "developers" && answerValue(answers, "product_type") === "api_service") {
        return {
          optionId: "email_oauth",
          rationale:
            "A user/account control plane with OAuth is a safer default even when the main product surface is API access.",
        };
      }
      return {
        optionId: "email_oauth",
        rationale:
          "Email plus OAuth is a mature default with low onboarding friction and broad provider support.",
      };
    },
  },
  {
    id: "tenancy",
    title: "Tenancy / organizations",
    prompt: "How should customer/workspace ownership be modeled?",
    when: (answers) =>
      answerValue(answers, "authentication") !== "none" &&
      !["cli", "internal_tool"].includes(answerValue(answers, "product_type") ?? ""),
    options: [
      option("single_user", "Individual accounts", "Resources belong directly to one user."),
      option(
        "organizations",
        "Organizations / workspaces",
        "Users belong to tenant organizations/workspaces.",
      ),
      option(
        "single_tenant",
        "Single tenant deployment",
        "One customer/organization per deployment.",
      ),
    ],
    recommend: (answers) => ({
      optionId:
        answerValue(answers, "primary_users") === "business" ? "organizations" : "single_user",
      rationale:
        answerValue(answers, "primary_users") === "business"
          ? "B2B products usually need organization membership, roles and tenant-owned resources."
          : "Individual accounts avoid unnecessary tenancy complexity when organizations are not a core requirement.",
    }),
  },
  {
    id: "data_store",
    title: "Primary data model",
    prompt: "What should be the default primary persistence model?",
    customAllowed: true,
    when: (answers) =>
      answerValue(answers, "product_type") !== "cli" ||
      answerValue(answers, "maturity") !== "prototype",
    options: [
      option(
        "postgresql",
        "PostgreSQL",
        "Relational transactional database with mature migration tooling.",
      ),
      option(
        "managed_postgres",
        "Managed PostgreSQL",
        "PostgreSQL with managed hosting/platform services.",
      ),
      option(
        "document_db",
        "Document database",
        "Document-oriented storage where aggregate documents dominate.",
      ),
      option("local_sqlite", "SQLite", "Local/small deployment relational database."),
      option("none", "No primary database", "Stateless or externally persisted system."),
    ],
    recommend: (answers) => {
      const type = answerValue(answers, "product_type");
      const maturity = answerValue(answers, "maturity");

      if (type === "cli" && maturity === "prototype") {
        return {
          optionId: "local_sqlite",
          rationale: "A local prototype CLI benefits from a zero-ops embedded relational store.",
        };
      }

      if (["saas_web", "internal_tool", "api_service"].includes(type ?? "")) {
        return {
          optionId: "managed_postgres",
          rationale:
            "Transactional products with users, permissions and evolving domain relationships are best served by PostgreSQL; managed hosting reduces operational overhead.",
        };
      }

      return {
        optionId: "postgresql",
        rationale:
          "PostgreSQL is the safest general-purpose default for structured application data.",
      };
    },
  },
  {
    id: "deployment",
    title: "Deployment model",
    prompt: "What deployment model should the initial architecture optimize for?",
    customAllowed: true,
    options: [
      option(
        "managed_cloud",
        "Managed cloud",
        "Managed application/database services with minimal operations overhead.",
      ),
      option(
        "docker",
        "Self-hosted Docker",
        "Portable container deployment without Kubernetes complexity.",
      ),
      option("serverless", "Serverless / edge", "Function/edge-first deployment."),
      option("kubernetes", "Kubernetes", "Cluster orchestration and platform operations."),
      option("local_only", "Local only", "No hosted production environment."),
    ],
    recommend: (answers) => {
      if (answerValue(answers, "product_type") === "cli") {
        return {
          optionId: "local_only",
          rationale:
            "A CLI product should default to local execution unless a hosted control plane is required.",
        };
      }

      if (answerValue(answers, "maturity") === "production") {
        return {
          optionId: "managed_cloud",
          rationale:
            "Managed cloud keeps production reliability high without introducing Kubernetes/platform overhead by default.",
        };
      }

      return {
        optionId: "managed_cloud",
        rationale:
          "Managed cloud is the lowest-operations default for MVP delivery and keeps deployment complexity proportional to product maturity.",
      };
    },
  },
  {
    id: "testing",
    title: "Quality strategy",
    prompt: "What testing/quality baseline should the project enforce?",
    options: [
      option("prototype", "Prototype checks", "Fast smoke tests and minimal quality gates."),
      option("balanced", "Balanced", "Unit + integration tests and E2E for critical flows."),
      option(
        "strict",
        "Strict production",
        "Unit/integration/E2E plus stronger reliability and contract gates.",
      ),
    ],
    recommend: (answers) => ({
      optionId: answerValue(answers, "maturity") === "production" ? "strict" : "balanced",
      rationale:
        answerValue(answers, "maturity") === "production"
          ? "Production systems should make reliability/contract regressions explicit before delivery."
          : "Balanced coverage gives an MVP useful confidence without making every path an expensive E2E test.",
    }),
  },
  {
    id: "security",
    title: "Security posture",
    prompt: "What security/compliance posture should planning assume?",
    customAllowed: true,
    options: [
      option(
        "standard",
        "Standard application security",
        "Least privilege, secure defaults, audit-sensitive design.",
      ),
      option(
        "elevated",
        "Elevated",
        "Sensitive business/personal data with stronger audit and access controls.",
      ),
      option(
        "regulated",
        "Regulated/compliance-heavy",
        "Formal regulatory/security controls are expected.",
      ),
      option("internal", "Internal-only", "Restricted internal network/identity boundary."),
    ],
    recommend: (answers) => ({
      optionId: answerValue(answers, "primary_users") === "internal" ? "internal" : "standard",
      rationale:
        answerValue(answers, "primary_users") === "internal"
          ? "Internal-only products can use the existing organization identity/network boundary while retaining least privilege."
          : "Standard application security is the correct baseline unless the product handles specifically sensitive or regulated data.",
    }),
  },
];

export function discoverySessionPath(workspaceDirectory: string): string {
  return resolve(workspaceDirectory, "planning", "discovery.json");
}

export async function isGreenfieldRepository(root: string): Promise<boolean> {
  const entries = await readdir(root, { withFileTypes: true });
  const ignorable = new Set([
    ".git",
    ".gitignore",
    ".gitattributes",
    ".editorconfig",
    "README",
    "README.md",
    "README.txt",
    "LICENSE",
    "LICENSE.md",
  ]);

  return entries.every((entry) => ignorable.has(entry.name));
}

async function writeAtomic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = path + "." + randomUUID() + ".tmp";
  await writeFile(temporary, content, "utf8");

  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export async function createDiscoverySession(
  projectRoot: string,
  workspaceDirectory: string,
  idea: string,
): Promise<DiscoverySession> {
  const value = idea.trim();
  if (!value) throw new Error("Project idea must not be empty.");

  const now = new Date().toISOString();
  const session: DiscoverySession = {
    version: 1,
    sessionId: randomUUID(),
    projectRoot: resolve(projectRoot),
    idea: value,
    status: "in_progress",
    policyPackVersion: 1,
    createdAt: now,
    updatedAt: now,
    answers: {},
  };

  await saveDiscoverySession(workspaceDirectory, session);
  return session;
}

export async function saveDiscoverySession(
  workspaceDirectory: string,
  session: DiscoverySession,
): Promise<void> {
  await writeAtomic(
    discoverySessionPath(workspaceDirectory),
    JSON.stringify(session, null, 2) + "\n",
  );
}

export async function loadDiscoverySession(
  workspaceDirectory: string,
): Promise<DiscoverySession | undefined> {
  try {
    const raw = await readFile(discoverySessionPath(workspaceDirectory), "utf8");
    const parsed = JSON.parse(raw) as DiscoverySession;

    if (
      parsed.version !== 1 ||
      typeof parsed.sessionId !== "string" ||
      typeof parsed.idea !== "string" ||
      !parsed.answers
    ) {
      throw new Error("Discovery state has an unsupported shape.");
    }

    return parsed;
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : undefined;
    if (code === "ENOENT") return undefined;
    throw error;
  }
}

function materializeQuestion(
  definition: QuestionDefinition,
  session: DiscoverySession,
): DiscoveryQuestion {
  return {
    id: definition.id,
    title: definition.title,
    prompt: definition.prompt,
    options: definition.options,
    customAllowed: definition.customAllowed ?? false,
    recommendation: definition.recommend(session.answers, session.idea),
  };
}

export function nextDiscoveryQuestion(session: DiscoverySession): DiscoveryQuestion | undefined {
  const definition = QUESTIONS.find((question) => {
    if (session.answers[question.id]) return false;
    return question.when ? question.when(session.answers) : true;
  });

  return definition ? materializeQuestion(definition, session) : undefined;
}

export function discoveryQuestion(
  session: DiscoverySession,
  questionId: string,
): DiscoveryQuestion {
  const definition = QUESTIONS.find((question) => question.id === questionId);
  if (!definition) throw new Error("Unknown discovery question: " + questionId + ".");
  if (definition.when && !definition.when(session.answers)) {
    throw new Error("Discovery question " + questionId + " is not applicable to this session.");
  }
  return materializeQuestion(definition, session);
}

export async function answerDiscoveryQuestion(
  workspaceDirectory: string,
  session: DiscoverySession,
  questionId: string,
  input: DiscoveryAnswerInput,
): Promise<DiscoverySession> {
  const question = discoveryQuestion(session, questionId);
  let value: string;
  let label: string;
  let source: DiscoveryAnswerSource;
  let rationale: string | undefined;

  if (input.mode === "custom") {
    const custom = input.value?.trim();
    if (!question.customAllowed || !custom) {
      throw new Error("A non-empty custom answer is required for " + question.title + ".");
    }
    value = custom;
    label = custom;
    source = "user_custom";
  } else {
    const selectedId =
      input.mode === "option" ? input.value?.trim() : question.recommendation.optionId;
    const selected = question.options.find((option) => option.id === selectedId);

    if (!selected) {
      throw new Error("Selected discovery option is invalid for " + question.title + ".");
    }

    value = selected.id;
    label = selected.label;
    rationale = input.mode === "option" ? undefined : question.recommendation.rationale;
    source =
      input.mode === "delegate"
        ? "llmatic_delegated"
        : input.mode === "recommended"
          ? "recommended_confirmed"
          : "user_option";
  }

  const now = new Date().toISOString();
  const updated: DiscoverySession = {
    ...session,
    updatedAt: now,
    answers: {
      ...session.answers,
      [questionId]: {
        questionId,
        value,
        label,
        source,
        rationale,
        answeredAt: now,
      },
    },
  };

  updated.status = nextDiscoveryQuestion(updated) ? "in_progress" : "ready_for_planning";

  await saveDiscoverySession(workspaceDirectory, updated);
  return updated;
}

export function discoverySummary(session: DiscoverySession): string {
  const lines = ["Idea: " + session.idea, "Status: " + session.status, "", "Decisions:"];

  for (const question of QUESTIONS) {
    const answer = session.answers[question.id];
    if (!answer) continue;
    lines.push(
      "- " +
        question.title +
        ": " +
        answer.label +
        " [" +
        answer.source +
        "]" +
        (answer.rationale ? " — " + answer.rationale : ""),
    );
  }

  return lines.join("\n");
}


export interface AnsweredDiscoveryQuestion {
  id: string;
  title: string;
  answer: DiscoveryAnswer;
}

export function answeredDiscoveryQuestions(
  session: DiscoverySession,
): AnsweredDiscoveryQuestion[] {
  return QUESTIONS.flatMap((question) => {
    const answer = session.answers[question.id];
    return answer
      ? [{ id: question.id, title: question.title, answer }]
      : [];
  });
}

export async function reopenDiscoveryAt(
  workspaceDirectory: string,
  session: DiscoverySession,
  questionId: string,
): Promise<DiscoverySession> {
  const index = QUESTIONS.findIndex((question) => question.id === questionId);
  if (index < 0) {
    throw new Error("Unknown discovery question: " + questionId + ".");
  }

  const removeIds = new Set(
    QUESTIONS.slice(index).map((question) => question.id),
  );
  const answers = Object.fromEntries(
    Object.entries(session.answers).filter(
      ([id]) => !removeIds.has(id),
    ),
  );

  const updated: DiscoverySession = {
    ...session,
    status: "in_progress",
    updatedAt: new Date().toISOString(),
    answers,
  };

  await saveDiscoverySession(workspaceDirectory, updated);
  return updated;
}
