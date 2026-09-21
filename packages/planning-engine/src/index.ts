import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { DiscoveryAnswer, DiscoverySession } from "@llmatic/discovery-engine";

export type ProjectPlanStatus = "draft_ready";

export interface ProjectPlanArtifact {
  id: string;
  title: string;
  relativePath: string;
  kind: "markdown" | "json";
}

export interface ProjectPlanTask {
  id: string;
  phase: string;
  summary: string;
  description: string;
  acceptanceCriteria: string[];
  definitionOfDone: string[];
  dependencies: string[];
}

export interface ProjectPlanManifest {
  version: 1;
  planId: string;
  discoverySessionId: string;
  projectRoot: string;
  status: ProjectPlanStatus;
  createdAt: string;
  updatedAt: string;
  policyPackVersion: 1;
  artifactCount: number;
  taskCount: number;
  artifacts: ProjectPlanArtifact[];
}

export interface CurrentProjectPlan {
  version: 1;
  planId: string;
  status: ProjectPlanStatus;
  planDirectory: string;
  manifestPath: string;
  discoverySessionId: string;
  updatedAt: string;
}

export interface GeneratedProjectPlan {
  current: CurrentProjectPlan;
  manifest: ProjectPlanManifest;
  tasks: ProjectPlanTask[];
}

export interface ProjectPlanGenerationOptions {
  changeRequest?: string;
}

interface ProductProfile {
  inferred: boolean;
  resourceSingular: string;
  resourcePlural: string;
  resourceSlug: string;
  resourceLabel: string;
  actions: string[];
  fields: string[];
  changeRequest?: string;
}

interface PlanContext {
  idea: string;
  productType: string;
  maturity: string;
  primaryUsers: string;
  applicationShape: string;
  authentication: string;
  tenancy: string;
  dataStore: string;
  deployment: string;
  testing: string;
  security: string;
  labels: {
    product_type: string;
    maturity: string;
    primary_users: string;
    application_shape: string;
    authentication: string;
    tenancy: string;
    data_store: string;
    deployment: string;
    testing: string;
    security: string;
  };
}

interface ArchitectureRecommendation {
  language: string;
  client: string;
  backend: string;
  persistence: string;
  deployment: string;
  repository: string;
  rationale: string[];
}

function answer(
  session: DiscoverySession,
  id: string,
  fallbackValue: string,
  fallbackLabel: string,
): DiscoveryAnswer {
  return (
    session.answers[id] ?? {
      questionId: id,
      value: fallbackValue,
      label: fallbackLabel,
      source: "llmatic_delegated",
      rationale: "Planning fallback used because the discovery question was not applicable.",
      answeredAt: session.updatedAt,
    }
  );
}

function contextFor(session: DiscoverySession): PlanContext {
  const values = {
    product_type: answer(session, "product_type", "saas_web", "SaaS web application"),
    maturity: answer(session, "maturity", "mvp", "MVP"),
    primary_users: answer(session, "primary_users", "business", "Business customers"),
    application_shape: answer(session, "application_shape", "fullstack_web", "Full-stack web"),
    authentication: answer(session, "authentication", "none", "No authentication"),
    tenancy: answer(session, "tenancy", "single_user", "Individual accounts"),
    data_store: answer(session, "data_store", "none", "No primary database"),
    deployment: answer(session, "deployment", "managed_cloud", "Managed cloud"),
    testing: answer(session, "testing", "balanced", "Balanced"),
    security: answer(session, "security", "standard", "Standard application security"),
  };

  return {
    idea: session.idea,
    productType: values.product_type.value,
    maturity: values.maturity.value,
    primaryUsers: values.primary_users.value,
    applicationShape: values.application_shape.value,
    authentication: values.authentication.value,
    tenancy: values.tenancy.value,
    dataStore: values.data_store.value,
    deployment: values.deployment.value,
    testing: values.testing.value,
    security: values.security.value,
    labels: {
      product_type: values.product_type.label,
      maturity: values.maturity.label,
      primary_users: values.primary_users.label,
      application_shape: values.application_shape.label,
      authentication: values.authentication.label,
      tenancy: values.tenancy.label,
      data_store: values.data_store.label,
      deployment: values.deployment.label,
      testing: values.testing.label,
      security: values.security.label,
    },
  };
}

function architectureRecommendation(context: PlanContext): ArchitectureRecommendation {
  let client = "No first-party client";
  let backend = "TypeScript / Node.js service";
  let repository = "Single repository with package/domain boundaries";

  if (context.applicationShape === "fullstack_web") {
    client = "TypeScript + React web client";
    backend = "TypeScript / Node.js API and application service layer";
    repository =
      "TypeScript workspace/monorepo with explicit web, server and shared-contract boundaries";
  } else if (context.applicationShape === "frontend_only") {
    client = "TypeScript + React static/client application";
    backend = "External APIs only";
    repository = "Single frontend application with typed external API clients";
  } else if (context.applicationShape === "desktop_app") {
    client = "TypeScript desktop UI with a thin runtime shell";
    backend = "Local application service layer; remote API only when required";
    repository = "Single repository with desktop shell, UI, domain and infrastructure boundaries";
  } else if (context.applicationShape === "cli_app") {
    client = "TypeScript CLI";
    backend = "Local domain/application layer";
    repository = "Single package or small workspace with CLI, domain and adapter boundaries";
  }

  let persistence = "No primary application database";
  if (context.dataStore === "managed_postgres") {
    persistence = "Managed PostgreSQL with migration-first schema management";
  } else if (context.dataStore === "postgresql") {
    persistence = "PostgreSQL with migration-first schema management";
  } else if (context.dataStore === "local_sqlite") {
    persistence = "SQLite with explicit migrations";
  } else if (context.dataStore === "document_db") {
    persistence = "Document database with versioned aggregate/document schemas";
  }

  const deployment =
    context.deployment === "local_only"
      ? "Local installation/execution"
      : context.deployment === "docker"
        ? "Docker-based deploy with environment-specific configuration"
        : context.deployment === "serverless"
          ? "Managed serverless/edge runtime"
          : context.deployment === "kubernetes"
            ? "Kubernetes with declarative infrastructure and health probes"
            : "Managed cloud application/database services";

  return {
    language:
      "TypeScript for application code unless a domain-specific requirement justifies another language",
    client,
    backend,
    persistence,
    deployment,
    repository,
    rationale: [
      "Use one primary language where practical to reduce contract drift and toolchain overhead.",
      "Keep domain/application logic independent from UI, transport and persistence adapters.",
      "Use typed contracts at process and API boundaries.",
      "Prefer the simplest deployment model compatible with the selected maturity target.",
      "Treat migrations, tests, observability and security controls as architecture, not post-build additions.",
    ],
  };
}

function md(title: string, sections: Array<[string, string]>): string {
  const lines = ["# " + title, ""];
  for (const [heading, body] of sections) {
    lines.push("## " + heading, "", body.trim(), "");
  }
  return lines.join("\n").trimEnd() + "\n";
}

function list(items: string[]): string {
  return items.map((item) => "- " + item).join("\n");
}

const RESOURCE_STOP_WORDS = new Set([
  "application",
  "applications",
  "product",
  "products",
  "system",
  "systems",
  "user",
  "users",
  "data",
  "workflow",
  "workflows",
  "service",
  "services",
  "api",
  "backend",
  "frontend",
  "account",
  "accounts",
]);

function singularizeResource(value: string): string {
  const word = value.toLowerCase();
  if (word.endsWith("ies") && word.length > 3) return word.slice(0, -3) + "y";
  if (word.endsWith("ses") && word.length > 3) return word.slice(0, -2);
  if (word.endsWith("s") && !word.endsWith("ss") && word.length > 3) return word.slice(0, -1);
  return word;
}

function pluralizeResource(value: string): string {
  if (value.endsWith("y") && !/[aeiou]y$/.test(value)) return value.slice(0, -1) + "ies";
  if (/(s|x|z|ch|sh)$/.test(value)) return value + "es";
  return value + "s";
}

function resourceLabel(value: string): string {
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
}

function inferResource(text: string): string | undefined {
  const candidates: string[] = [];
  const management = text.match(
    /\b([a-z][a-z0-9_-]{2,})\s+(?:management|manager|tracking|tracker)\b/i,
  );
  if (management?.[1]) candidates.push(management[1]);

  const actionPattern =
    /\b(?:create|add|view|list|edit|update|complete|uncomplete|delete|remove|manage|track|store|publish|upload|download|book|schedule)\s+(?:their\s+own\s+|their\s+|the\s+|a\s+|an\s+)?([a-z][a-z0-9_-]{2,})\b/gi;
  for (const match of text.matchAll(actionPattern)) {
    if (match[1]) candidates.push(match[1]);
  }

  const usable = candidates
    .map((candidate) => candidate.replace(/[^a-z0-9_-]/gi, "").toLowerCase())
    .filter((candidate) => candidate && !RESOURCE_STOP_WORDS.has(candidate));
  if (usable.length === 0) return undefined;

  const counts = new Map<string, number>();
  for (const candidate of usable) {
    const singular = singularizeResource(candidate);
    counts.set(singular, (counts.get(singular) ?? 0) + 1);
  }

  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
}

function inferActions(text: string): string[] {
  const actionAliases: Array<[RegExp, string]> = [
    [/\b(create|add)\b/i, "create"],
    [/\b(view|read)\b/i, "view"],
    [/\blist\b/i, "list"],
    [/\b(edit|update)\b/i, "edit"],
    [/\buncomplete\b/i, "uncomplete"],
    [/\bcomplete\b/i, "complete"],
    [/\b(delete|remove)\b/i, "delete"],
  ];
  return actionAliases.flatMap(([pattern, action]) => (pattern.test(text) ? [action] : []));
}

function inferFields(text: string, context: PlanContext): string[] {
  const fields = ["id"];
  if (context.authentication !== "none") {
    fields.push(context.tenancy === "organizations" ? "organizationId" : "ownerUserId");
  }
  if (/\btitle\b/i.test(text)) fields.push("title");
  if (/\bdescription\b/i.test(text)) fields.push("description");
  if (/\b(completion|complete|completed)\b/i.test(text)) fields.push("completed");
  if (
    /\bcreated(?:At|\s+timestamp)?\b/i.test(text) ||
    /\bcreated\/updated timestamps\b/i.test(text)
  ) {
    fields.push("createdAt");
  }
  if (
    /\bupdated(?:At|\s+timestamp)?\b/i.test(text) ||
    /\bcreated\/updated timestamps\b/i.test(text)
  ) {
    fields.push("updatedAt");
  }
  return [...new Set(fields)];
}

function productProfile(
  context: PlanContext,
  options: ProjectPlanGenerationOptions,
): ProductProfile {
  const changeRequest = options.changeRequest?.trim() || undefined;
  const source = [context.idea, changeRequest].filter(Boolean).join("\n");
  const resourceSingular = inferResource(source) ?? "domain resource";
  const inferred = resourceSingular !== "domain resource";
  const resourcePlural = inferred ? pluralizeResource(resourceSingular) : "domain resources";
  const slugBase = inferred ? resourcePlural : "resources";

  return {
    inferred,
    resourceSingular,
    resourcePlural,
    resourceSlug: slugBase
      .replace(/[^a-z0-9]+/gi, "-")
      .replace(/^-|-$/g, "")
      .toLowerCase(),
    resourceLabel: inferred ? resourceLabel(resourceSingular) : "Domain resource",
    actions: inferActions(source),
    fields: inferFields(source, context),
    changeRequest,
  };
}

function actionPhrase(profile: ProductProfile): string {
  return profile.actions.length > 0 ? profile.actions.join(", ") : "the approved lifecycle actions";
}

function ownershipRequirement(context: PlanContext, profile: ProductProfile): string {
  if (context.authentication === "none") {
    return "Public resource access must follow the explicitly approved no-auth trust boundary.";
  }
  if (context.tenancy === "organizations") {
    return (
      "Every " +
      profile.resourceSingular +
      " read and mutation must enforce organization/workspace ownership server-side."
    );
  }
  return (
    "An authenticated user may read or mutate only " +
    profile.resourcePlural +
    " owned by that user."
  );
}

function decisionTable(session: DiscoverySession): string {
  const ordered = [
    "product_type",
    "maturity",
    "primary_users",
    "application_shape",
    "authentication",
    "tenancy",
    "data_store",
    "deployment",
    "testing",
    "security",
  ];

  const rows = ordered.flatMap((id) => {
    const item = session.answers[id];
    if (!item) return [];
    return [
      "| " +
        id +
        " | " +
        item.label.replaceAll("|", "\\|") +
        " | " +
        item.source +
        " | " +
        (item.rationale ?? "User selected").replaceAll("|", "\\|") +
        " |",
    ];
  });

  return ["| Decision | Value | Source | Rationale |", "| --- | --- | --- | --- |", ...rows].join(
    "\n",
  );
}

function productBrief(
  session: DiscoverySession,
  context: PlanContext,
  profile: ProductProfile,
): string {
  const sections: Array<[string, string]> = [
    ["Product idea", context.idea],
    [
      "Target",
      list([
        "Product type: " + context.labels.product_type,
        "Primary users: " + context.labels.primary_users,
        "Delivery target: " + context.labels.maturity,
        "Application shape: " + context.labels.application_shape,
      ]),
    ],
    [
      "Product objective",
      "Build the smallest coherent " +
        context.labels.maturity.toLowerCase() +
        " that solves the stated problem while preserving a production-capable path for security, testing, data ownership and operations.",
    ],
    [
      "Scope principles",
      list([
        "Ship complete user journeys rather than disconnected screens/endpoints.",
        "Keep the first release deliberately narrow.",
        "Make authorization and data ownership explicit.",
        "Do not treat missing evidence as success.",
        "Prefer reversible architecture decisions until usage proves otherwise.",
        "Capture consequential architecture changes as ADRs.",
      ]),
    ],
  ];

  if (profile.changeRequest) {
    sections.push(["Requested plan refinements", profile.changeRequest]);
  }

  sections.push(["Discovery decisions", decisionTable(session)]);
  return md("Product Brief", sections);
}

function requirements(context: PlanContext, profile: ProductProfile): string {
  const authenticated = context.authentication !== "none";
  const organizations = context.tenancy === "organizations";
  const productRequirements = [
    "The implementation shall satisfy this approved product intent: " + context.idea,
  ];

  if (profile.inferred) {
    productRequirements.push(
      "The " + profile.resourceLabel + " lifecycle shall support " + actionPhrase(profile) + ".",
    );
    productRequirements.push(ownershipRequirement(context, profile));
    if (profile.fields.length > 0) {
      productRequirements.push(
        "The canonical " +
          profile.resourceLabel +
          " model shall represent: " +
          profile.fields.join(", ") +
          ".",
      );
    }
  }

  return md("Requirements", [
    ["Product-specific requirements", list(productRequirements)],
    ...(profile.changeRequest
      ? ([["Requested refinements", profile.changeRequest]] as Array<[string, string]>)
      : []),
    [
      "Functional requirements",
      list([
        "The system shall validate all externally supplied data at trust boundaries.",
        "The system shall expose deterministic error states rather than silent failure.",
        authenticated
          ? "The system shall authenticate users according to the selected identity model."
          : "The public/no-auth boundary shall be documented explicitly.",
        authenticated
          ? "The system shall authorize access to every protected resource on the service boundary."
          : "Public resources shall not accidentally depend on hidden user identity.",
        organizations
          ? "Tenant-owned resources shall carry explicit organization/workspace ownership."
          : "Resource ownership shall follow the selected account/deployment model.",
      ]),
    ],
    [
      "Non-functional requirements",
      list([
        "Configuration and secrets must stay outside source control.",
        "Schema and API changes must be versioned or migration-safe.",
        "Critical flows must be observable with structured diagnostics.",
        "Local quality gates must be reproducible in CI.",
        "Security-sensitive checks fail closed.",
      ]),
    ],
    [
      "Explicit exclusions for the first delivery",
      list([
        "Premature microservice decomposition.",
        "Kubernetes unless explicitly selected.",
        "Multiple competing persistence models without a demonstrated need.",
        "Hidden business rules implemented only in UI code.",
        "Production deployment before approval and initialization.",
      ]),
    ],
  ]);
}

function journeys(context: PlanContext, profile: ProductProfile): string {
  const auth =
    context.authentication === "none"
      ? "enters directly"
      : "signs in using the selected identity flow";
  const tenant =
    context.tenancy === "organizations"
      ? "selects or creates the organization/workspace"
      : "uses the authenticated individual account";

  if (!profile.inferred) {
    return md("User Journeys", [
      ["Approved product intent", context.idea],
      [
        "Journey 1 — First successful outcome",
        [
          "1. The primary user opens the product.",
          "2. The user " + auth + ".",
          "3. The user " + tenant + ".",
          "4. The user completes the minimum workflow required by the approved product intent.",
          "5. The system validates and processes the request with explicit state.",
          "6. The user receives the primary outcome plus actionable errors where relevant.",
        ].join("\n"),
      ],
    ]);
  }

  return md("User Journeys", [
    [
      "Journey 1 — First successful outcome",
      [
        "1. The primary user opens the product.",
        "2. The user " + auth + ".",
        "3. The user " + tenant + ".",
        "4. The user opens the " +
          profile.resourcePlural +
          " view and sees an explicit empty or loaded state.",
        "5. The user creates a " + profile.resourceSingular + " with valid product-specific input.",
        "6. The new " +
          profile.resourceSingular +
          " appears in the user's " +
          profile.resourcePlural +
          " collection.",
      ].join("\n"),
    ],
    [
      "Journey 2 — Returning user lifecycle",
      [
        "1. Existing identity context is restored safely.",
        "2. Existing " + profile.resourcePlural + " owned by the current user are discoverable.",
        "3. The user can " + actionPhrase(profile) + " according to the approved lifecycle.",
        "4. Mutations remain scoped to the authenticated owner and return deterministic errors on failure.",
      ].join("\n"),
    ],
    [
      "Journey 3 — Authorization and recovery",
      [
        "1. Invalid or incomplete " + profile.resourceSingular + " input is rejected explicitly.",
        "2. Attempts to access another owner's " +
          profile.resourcePlural +
          " are rejected server-side.",
        "3. Recoverable user input is preserved where feasible and retry does not create duplicate side effects.",
      ].join("\n"),
    ],
  ]);
}

function architecture(context: PlanContext, recommendation: ArchitectureRecommendation): string {
  return md("Architecture", [
    [
      "Recommended shape",
      list([
        "Primary language: " + recommendation.language,
        "Client: " + recommendation.client,
        "Backend/application layer: " + recommendation.backend,
        "Persistence: " + recommendation.persistence,
        "Deployment: " + recommendation.deployment,
        "Repository: " + recommendation.repository,
      ]),
    ],
    [
      "Layer boundaries",
      [
        "    UI / CLI / external client",
        "        |",
        "        v",
        "    transport / input validation",
        "        |",
        "        v",
        "    application use-cases",
        "        |",
        "        v",
        "    domain model + policies",
        "        |",
        "        v",
        "    ports/interfaces -> persistence / identity / integrations / observability",
      ].join("\n"),
    ],
    [
      "Architectural rules",
      list([
        "Domain logic must not import UI/framework-specific code.",
        "External integrations sit behind explicit adapters.",
        "Persistence and API contracts evolve through reviewed migrations/contracts.",
        "Authorization belongs on service/use-case boundaries, not only in clients.",
        "Retryable side effects require idempotency.",
        "Unknown/incomplete data remains distinguishable from successful/clear results.",
      ]),
    ],
    ["Rationale", list(recommendation.rationale)],
  ]);
}

function adr(
  number: number,
  title: string,
  context: string,
  decision: string,
  consequences: string[],
): string {
  return md("ADR-" + String(number).padStart(3, "0") + " — " + title, [
    ["Status", "Proposed"],
    ["Context", context],
    ["Decision", decision],
    ["Consequences", list(consequences)],
  ]);
}

function dataModel(context: PlanContext, profile: ProductProfile): string {
  if (context.dataStore === "none") {
    return md("Data Model", [
      ["Product intent", context.idea],
      [
        "Decision",
        list([
          "No primary application database is assumed.",
          "Persist only data required by the actual workflow.",
          "Version durable file/document formats.",
          "Revisit this through an ADR before adding a primary database.",
        ]),
      ],
    ]);
  }

  const entities: string[] = [];
  if (context.tenancy === "organizations") entities.push("Organization", "Membership");
  if (context.authentication !== "none") entities.push("User / identity reference");
  entities.push(profile.resourceLabel);

  const fieldDetails = profile.fields.map((field) => {
    if (field === "id") return "id — stable unique identifier";
    if (field === "ownerUserId") return "ownerUserId — authenticated user ownership reference";
    if (field === "organizationId")
      return "organizationId — owning organization/workspace reference";
    if (field === "title") return "title — required human-readable title";
    if (field === "description") return "description — optional descriptive text";
    if (field === "completed") return "completed — explicit completion state";
    if (field === "createdAt") return "createdAt — creation timestamp";
    if (field === "updatedAt") return "updatedAt — last-update timestamp";
    return field;
  });

  return md("Data Model", [
    ["Primary persistence", context.labels.data_store],
    ["Foundational entities", list(entities)],
    ...(fieldDetails.length > 0
      ? ([[profile.resourceLabel + " fields", list(fieldDetails)]] as Array<[string, string]>)
      : []),
    [
      "Ownership and lifecycle",
      list([
        ownershipRequirement(context, profile),
        "Delete/cascade behavior must be explicit and tested.",
        "State transitions must preserve domain invariants.",
      ]),
    ],
    [
      "Data rules",
      list([
        "Use database constraints for invariants that must survive application bugs.",
        "Use migrations for every persistent schema change.",
        "Do not overload null to mean both unknown and not-applicable.",
      ]),
    ],
  ]);
}

function apiContracts(context: PlanContext, profile: ProductProfile): string {
  if (["cli_app", "desktop_app"].includes(context.applicationShape)) {
    return md("API Contracts", [
      ["Product intent", context.idea],
      [
        "Contract rules",
        list([
          "No mandatory public HTTP API is assumed for the first delivery.",
          "Internal use-cases expose typed request/result contracts for " +
            profile.resourcePlural +
            ".",
          "CLI/desktop inputs are validated before domain execution.",
          "External integrations use typed adapter interfaces.",
        ]),
      ],
    ]);
  }

  const collection = "/api/" + profile.resourceSlug;
  return md("API Contracts", [
    [
      "Baseline conventions",
      list([
        "JSON request/response bodies.",
        "Runtime validation at every external input boundary.",
        "Stable machine-readable error codes.",
        "Explicit authentication/authorization requirements per route.",
        "Idempotency keys for retryable create/side-effect operations.",
        "Pagination for unbounded collections.",
        "No duplicate endpoints with overlapping semantics.",
      ]),
    ],
    [
      profile.inferred ? profile.resourceLabel + " routes" : "Initial resource pattern",
      [
        "    GET    /api/health",
        "    GET    " + collection,
        "    GET    " + collection + "/:id",
        "    POST   " + collection,
        "    PATCH  " + collection + "/:id",
        "    DELETE " + collection + "/:id",
      ].join("\n"),
    ],
    [
      "Contract semantics",
      list([
        profile.inferred
          ? "POST creates a " + profile.resourceSingular + " owned by the authenticated scope."
          : "POST creates the approved resource.",
        "PATCH supports approved edits/state transitions without changing ownership.",
        "DELETE follows the explicit deletion behavior in the approved data model.",
        ownershipRequirement(context, profile),
      ]),
    ],
  ]);
}

function security(context: PlanContext): string {
  return md("Security Model", [
    ["Security posture", context.labels.security],
    [
      "Identity and authorization",
      list([
        context.authentication === "none"
          ? "No user authentication is assumed; public/private trust boundaries must be explicit."
          : "Authentication uses " + context.labels.authentication + ".",
        context.tenancy === "organizations"
          ? "Every tenant-owned query/mutation enforces organization scope server-side."
          : "Resource ownership follows " + context.labels.tenancy + ".",
        "Default deny for privileged operations.",
        "Never trust client-supplied role/tenant ownership without server-side verification.",
      ]),
    ],
    [
      "Secrets and input safety",
      list([
        "Secrets live in environment/secret stores, never source control or logs.",
        "Validate and normalize untrusted input.",
        "Parameterize database access.",
        "Restrict file/path access to approved roots.",
      ]),
    ],
  ]);
}

function testing(context: PlanContext): string {
  const level =
    context.testing === "strict"
      ? "Strict production baseline"
      : context.testing === "prototype"
        ? "Prototype baseline"
        : "Balanced baseline";
  const gates = ["format", "lint", "typecheck", "tests", "build/package"];
  if (context.testing === "strict") {
    gates.push("contract/regression", "migration/restore", "security acceptance");
  }

  return md("Testing Strategy", [
    ["Selected level", level],
    [
      "Unit tests",
      list([
        "Domain policies and transformations.",
        "Input validation.",
        "Authorization policy.",
        "Retry/idempotency logic.",
      ]),
    ],
    [
      "Integration tests",
      list([
        "Persistence contracts.",
        "Identity/authorization boundaries.",
        "External adapters.",
        "Migration upgrade path where applicable.",
      ]),
    ],
    [
      "End-to-end tests",
      list([
        "First successful outcome.",
        "Authorization rejection.",
        "Invalid/incomplete input recovery.",
        "One returning-user journey.",
      ]),
    ],
    ["Quality gates", list(gates)],
  ]);
}

function operations(context: PlanContext): string {
  return md("Observability & Operations", [
    ["Deployment target", context.labels.deployment],
    [
      "Structured logging",
      list([
        "correlation/run id",
        "operation name",
        "outcome",
        "duration",
        "safe error code",
        "safe resource identifiers",
      ]),
    ],
    [
      "Health and metrics",
      list([
        "readiness/startup state",
        "request/job success and failure",
        "latency",
        "retry count",
        "external dependency failures",
      ]),
    ],
    [
      "Recovery",
      list([
        "Backup/restore expectations match maturity.",
        "Migrations have forward-recovery or rollback strategy.",
        "Deployments keep a known rollback path.",
        "Retryable side effects are idempotent.",
      ]),
    ],
  ]);
}

function phaseTasks(context: PlanContext, profile: ProductProfile): ProjectPlanTask[] {
  const tasks: ProjectPlanTask[] = [];
  const add = (task: ProjectPlanTask) => tasks.push(task);
  const baseDod = [
    "tests for changed behavior pass",
    "affected documentation/contracts are updated",
  ];
  const resource = profile.resourceLabel;
  const resourceLower = profile.resourceSingular;

  add({
    id: "PLAN-001",
    phase: "Phase 0 — Foundation",
    summary: "Initialize repository foundation and canonical toolchain",
    description:
      "Create the approved project structure, package/tool configuration and developer entrypoints.",
    dependencies: [],
    acceptanceCriteria: [
      "Repository structure matches approved architecture boundaries.",
      "Local install/bootstrap is reproducible.",
      "Secrets are excluded from source control.",
    ],
    definitionOfDone: [
      "format/lint/typecheck/build commands exist",
      "local foundation validation passes",
    ],
  });

  add({
    id: "PLAN-002",
    phase: "Phase 0 — Foundation",
    summary: "Establish CI and quality gates",
    description: "Run the same deterministic quality pipeline locally and in hosted CI.",
    dependencies: ["PLAN-001"],
    acceptanceCriteria: [
      "CI runs formatting, linting, type checking, tests and build/package gates.",
      "Local and hosted commands use the same canonical scripts.",
    ],
    definitionOfDone: ["green baseline CI run", "failure output identifies the failing gate"],
  });

  add({
    id: "PLAN-003",
    phase: "Phase 0 — Foundation",
    summary: "Define configuration and secret boundaries",
    description: "Create typed configuration loading and environment expectations.",
    dependencies: ["PLAN-001"],
    acceptanceCriteria: [
      "Required configuration fails fast.",
      "Secrets never enter committed config or logs.",
    ],
    definitionOfDone: baseDod,
  });

  add({
    id: "PLAN-010",
    phase: "Phase 1 — Domain",
    summary: profile.inferred
      ? "Define " + resource + " domain model and lifecycle use-cases"
      : "Implement canonical domain model and use-case contracts",
    description: profile.inferred
      ? "Implement the canonical " +
        resource +
        " model and use-cases for " +
        actionPhrase(profile) +
        "."
      : "Translate approved requirements/journeys into domain types, invariants and application use-cases.",
    dependencies: ["PLAN-001"],
    acceptanceCriteria: [
      profile.inferred
        ? resource + " ownership and lifecycle invariants are explicit and testable."
        : "Core domain concepts have stable ownership semantics.",
      "Business invariants are testable without UI/framework dependencies.",
    ],
    definitionOfDone: baseDod,
  });

  if (context.dataStore !== "none") {
    add({
      id: "PLAN-011",
      phase: "Phase 1 — Domain",
      summary: profile.inferred
        ? "Implement " + resource + " persistence schema and ownership constraints"
        : "Implement persistence schema and migration baseline",
      description: profile.inferred
        ? "Create the " +
          resource +
          " schema, ownership constraints, migrations and repository adapter."
        : "Create approved persistence model, constraints, migrations and repository adapters.",
      dependencies: ["PLAN-010", "PLAN-003"],
      acceptanceCriteria: [
        "Schema represents ownership and lifecycle explicitly.",
        "Migration applies from empty database.",
        "Database constraints protect critical invariants.",
      ],
      definitionOfDone: ["migration tests pass", "schema docs updated"],
    });
  }

  if (context.authentication !== "none") {
    add({
      id: "PLAN-012",
      phase: "Phase 1 — Identity",
      summary: "Implement authentication and owner identity boundary",
      description:
        "Integrate the approved identity mechanism and map authenticated users to resource ownership.",
      dependencies: ["PLAN-003"],
      acceptanceCriteria: [
        "Valid identity maps to internal actor/user reference.",
        "Unauthenticated protected access is rejected.",
      ],
      definitionOfDone: baseDod,
    });
  }

  if (context.tenancy === "organizations") {
    add({
      id: "PLAN-013",
      phase: "Phase 1 — Identity",
      summary: "Implement organizations, membership and authorization scope",
      description:
        "Establish tenant ownership, membership roles and server-side scope enforcement.",
      dependencies: ["PLAN-010", ...(context.authentication !== "none" ? ["PLAN-012"] : [])],
      acceptanceCriteria: [
        "Cross-tenant reads/writes are rejected.",
        "Membership roles are enforced server-side.",
      ],
      definitionOfDone: [
        "authorization regression tests pass",
        "tenant ownership represented in domain/persistence",
      ],
    });
  }

  const backendDeps = [
    "PLAN-010",
    ...(context.dataStore !== "none" ? ["PLAN-011"] : []),
    ...(context.authentication !== "none" ? ["PLAN-012"] : []),
    ...(context.tenancy === "organizations" ? ["PLAN-013"] : []),
  ];

  add({
    id: "PLAN-020",
    phase: "Phase 2 — Application",
    summary:
      profile.inferred && ["fullstack_web", "api_backend"].includes(context.applicationShape)
        ? "Implement " + resource + " API contracts and authorization"
        : ["fullstack_web", "api_backend"].includes(context.applicationShape)
          ? "Implement typed API contract and transport layer"
          : "Implement primary application command/use-case surface",
    description: profile.inferred
      ? "Expose the approved " +
        resourceLower +
        " lifecycle through typed contracts with validation, stable errors and ownership checks."
      : "Connect approved product inputs to canonical application use-cases with runtime validation and stable errors.",
    dependencies: backendDeps,
    acceptanceCriteria: [
      "External inputs are validated.",
      ownershipRequirement(context, profile),
      "Errors use stable machine-readable/structured contracts.",
    ],
    definitionOfDone: baseDod,
  });

  let journeyTaskId: string | undefined;
  if (["fullstack_web", "frontend_only"].includes(context.applicationShape)) {
    add({
      id: "PLAN-030",
      phase: "Phase 3 — Product UI",
      summary: profile.inferred
        ? "Implement " + resource + " list, empty, loading and error states"
        : "Implement application shell and primary navigation",
      description: profile.inferred
        ? "Create the primary " +
          profile.resourcePlural +
          " UI with explicit loading, empty and recoverable error states."
        : "Create accessible UI structure and loading/empty/error state patterns.",
      dependencies: context.applicationShape === "fullstack_web" ? ["PLAN-020"] : ["PLAN-001"],
      acceptanceCriteria: [
        "Navigation matches approved journeys.",
        "Loading, empty and error states are explicit.",
      ],
      definitionOfDone: baseDod,
    });

    add({
      id: "PLAN-031",
      phase: "Phase 3 — Product UI",
      summary: profile.inferred
        ? "Implement " + resource + " lifecycle end to end"
        : "Implement first successful user journey end to end",
      description: profile.inferred
        ? "Deliver the complete user flow for " +
          actionPhrase(profile) +
          " on owned " +
          profile.resourcePlural +
          "."
        : "Deliver the minimum coherent user flow that produces the core product outcome.",
      dependencies: [
        "PLAN-030",
        ...(context.applicationShape === "fullstack_web" ? ["PLAN-020"] : []),
      ],
      acceptanceCriteria: [
        profile.inferred
          ? "A real user can " +
            actionPhrase(profile) +
            " " +
            profile.resourcePlural +
            " through the product UI."
          : "A real user can complete the primary workflow.",
        "Validation, authorization and recoverable errors are represented in UI.",
      ],
      definitionOfDone: ["critical journey E2E passes", "journey docs match behavior"],
    });
    journeyTaskId = "PLAN-031";
  }

  add({
    id: "PLAN-040",
    phase: "Phase 4 — Quality",
    summary: "Complete integration and regression coverage",
    description: profile.inferred
      ? "Cover the " +
        resource +
        " lifecycle, persistence, identity, ownership authorization and recovery paths."
      : "Cover persistence, identity, authorization and failure recovery based on selected test policy.",
    dependencies: [journeyTaskId ?? "PLAN-020"],
    acceptanceCriteria: [
      "Critical cross-boundary behavior is tested.",
      profile.inferred
        ? "The complete " +
          resource +
          " lifecycle and cross-owner rejection have regression coverage."
        : "Known failure modes have regression coverage.",
    ],
    definitionOfDone: ["required quality gates pass", "no flaky test accepted as green evidence"],
  });

  add({
    id: "PLAN-041",
    phase: "Phase 4 — Operations",
    summary: "Implement observability and health baseline",
    description:
      "Add structured logs, correlation ids, health/readiness behavior and actionable metrics.",
    dependencies: ["PLAN-020"],
    acceptanceCriteria: [
      "Failures are diagnosable without debug builds.",
      "Logs do not leak secrets.",
    ],
    definitionOfDone: baseDod,
  });

  if (context.deployment !== "local_only") {
    add({
      id: "PLAN-042",
      phase: "Phase 4 — Operations",
      summary: "Implement repeatable deployment and rollback path",
      description:
        "Create selected deployment pipeline without production mutation during ordinary PR validation.",
      dependencies: ["PLAN-002", "PLAN-041"],
      acceptanceCriteria: [
        "Deployment artifact is reproducible.",
        "Environment configuration is explicit.",
        "Rollback/recovery path is documented.",
      ],
      definitionOfDone: [
        "staging/sandbox evidence exists",
        "production deploy remains permission-gated",
      ],
    });
  }

  const phase4 = tasks.filter((task) => task.phase.startsWith("Phase 4")).map((task) => task.id);

  add({
    id: "PLAN-050",
    phase: "Phase 5 — Acceptance",
    summary: "Run security and architecture conformance review",
    description:
      "Verify implementation against approved security model, ADRs and architecture boundaries.",
    dependencies: phase4,
    acceptanceCriteria: [
      "No unresolved blocking security findings remain.",
      "Architecture deviations have ADR or approved plan change.",
    ],
    definitionOfDone: ["review evidence recorded", "documentation impact checked"],
  });

  add({
    id: "PLAN-051",
    phase: "Phase 5 — Acceptance",
    summary: "Release acceptance for the first delivery",
    description:
      "Prove primary journeys, quality gates, operations evidence and release artifact together.",
    dependencies: ["PLAN-050"],
    acceptanceCriteria: [
      "All required CI gates are green.",
      "Primary journey acceptance passes.",
      "Release artifact/version metadata is verified.",
    ],
    definitionOfDone: [
      "release acceptance report complete",
      "release ready for explicit release/deploy approval",
    ],
  });

  return tasks;
}

function roadmap(tasks: ProjectPlanTask[]): string {
  const phases = [...new Set(tasks.map((task) => task.phase))];
  const body = phases
    .map((phase) => {
      const entries = tasks
        .filter((task) => task.phase === phase)
        .map((task) => "- **" + task.id + "** — " + task.summary)
        .join("\n");
      return "## " + phase + "\n\n" + entries;
    })
    .join("\n\n");

  return (
    "# Roadmap\n\n" +
    body +
    "\n\n## Execution rule\n\n" +
    "A task is eligible only when all declared dependencies are Done. " +
    "Each task must leave code, tests and affected documentation/contracts synchronized.\n"
  );
}

function tasksMarkdown(tasks: ProjectPlanTask[]): string {
  const blocks = tasks.map((task) =>
    [
      "## " + task.id + " — " + task.summary,
      "",
      "Status: Todo",
      "",
      "### Phase",
      "",
      task.phase,
      "",
      "### Description",
      "",
      task.description,
      "",
      "### Acceptance criteria",
      "",
      list(task.acceptanceCriteria),
      "",
      "### DoD",
      "",
      list(task.definitionOfDone),
      "",
      "### Dependencies",
      "",
      task.dependencies.length ? list(task.dependencies) : "- None",
    ].join("\n"),
  );

  return (
    "# Tasks\n\nGenerated from the active private LLMatic project plan.\n\n" +
    blocks.join("\n\n") +
    "\n"
  );
}

function dependencyGraph(tasks: ProjectPlanTask[]): string {
  return (
    JSON.stringify(
      {
        version: 1,
        nodes: tasks.map((task) => ({
          id: task.id,
          phase: task.phase,
          summary: task.summary,
        })),
        edges: tasks.flatMap((task) =>
          task.dependencies.map((dependency) => ({
            from: dependency,
            to: task.id,
            type: "blocks",
          })),
        ),
      },
      null,
      2,
    ) + "\n"
  );
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

export function plansRoot(workspaceDirectory: string): string {
  return resolve(workspaceDirectory, "planning", "plans");
}

export function currentPlanPath(workspaceDirectory: string): string {
  return resolve(workspaceDirectory, "planning", "current-plan.json");
}

export function planDirectory(workspaceDirectory: string, planId: string): string {
  return resolve(plansRoot(workspaceDirectory), planId);
}

export async function loadCurrentProjectPlan(
  workspaceDirectory: string,
): Promise<CurrentProjectPlan | undefined> {
  try {
    return JSON.parse(
      await readFile(currentPlanPath(workspaceDirectory), "utf8"),
    ) as CurrentProjectPlan;
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : undefined;
    if (code === "ENOENT") return undefined;
    throw error;
  }
}

export async function loadProjectPlanManifest(
  workspaceDirectory: string,
  planId?: string,
): Promise<ProjectPlanManifest | undefined> {
  const current = planId ? undefined : await loadCurrentProjectPlan(workspaceDirectory);
  const selectedId = planId ?? current?.planId;
  if (!selectedId) return undefined;

  try {
    return JSON.parse(
      await readFile(
        resolve(planDirectory(workspaceDirectory, selectedId), "plan-manifest.json"),
        "utf8",
      ),
    ) as ProjectPlanManifest;
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : undefined;
    if (code === "ENOENT") return undefined;
    throw error;
  }
}

export async function generateProjectPlan(
  workspaceDirectory: string,
  session: DiscoverySession,
  options: ProjectPlanGenerationOptions = {},
): Promise<GeneratedProjectPlan> {
  if (session.status !== "ready_for_planning") {
    throw new Error(
      "Project discovery is not complete. Finish discovery before generating a plan.",
    );
  }

  const context = contextFor(session);
  const profile = productProfile(context, options);
  const recommendation = architectureRecommendation(context);
  const tasks = phaseTasks(context, profile);
  const planId = randomUUID();
  const directory = planDirectory(workspaceDirectory, planId);
  const now = new Date().toISOString();

  const files = new Map<string, string>([
    ["PRODUCT_BRIEF.md", productBrief(session, context, profile)],
    ["REQUIREMENTS.md", requirements(context, profile)],
    ["USER_JOURNEYS.md", journeys(context, profile)],
    ["ARCHITECTURE.md", architecture(context, recommendation)],
    [
      "adr/ADR-001-application-architecture.md",
      adr(
        1,
        "Application architecture",
        "A coherent application shape must be approved before implementation.",
        "Use " + context.labels.application_shape + " with " + recommendation.repository + ".",
        recommendation.rationale,
      ),
    ],
    [
      "adr/ADR-002-persistence.md",
      adr(
        2,
        "Primary persistence",
        "Persistence boundaries and migration strategy must be explicit.",
        "Use " + recommendation.persistence + ".",
        [
          "Persistence remains behind application/domain ports.",
          "Durable schema changes are versioned.",
          "Changing primary persistence requires a replacement ADR.",
        ],
      ),
    ],
    [
      "adr/ADR-003-identity-tenancy.md",
      adr(
        3,
        "Identity and tenancy",
        "Identity and ownership affect every protected boundary.",
        "Use " + context.labels.authentication + " with " + context.labels.tenancy + ".",
        [
          "Authorization is enforced server-side/application-side.",
          "Ownership becomes part of domain/persistence contracts where applicable.",
          "Changing this model requires a migration plan.",
        ],
      ),
    ],
    ["DATA_MODEL.md", dataModel(context, profile)],
    ["API_CONTRACTS.md", apiContracts(context, profile)],
    ["SECURITY.md", security(context)],
    ["TESTING.md", testing(context)],
    ["OPERATIONS.md", operations(context)],
    ["ROADMAP.md", roadmap(tasks)],
    ["TASKS.md", tasksMarkdown(tasks)],
    ["dependency-graph.json", dependencyGraph(tasks)],
  ]);

  const artifacts: ProjectPlanArtifact[] = [...files.keys()].map((relativePath) => ({
    id: relativePath
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, ""),
    title: relativePath.replaceAll("_", " ").replace(/\.md$|\.json$/i, ""),
    relativePath,
    kind: relativePath.endsWith(".json") ? "json" : "markdown",
  }));

  const manifest: ProjectPlanManifest = {
    version: 1,
    planId,
    discoverySessionId: session.sessionId,
    projectRoot: session.projectRoot,
    status: "draft_ready",
    createdAt: now,
    updatedAt: now,
    policyPackVersion: 1,
    artifactCount: artifacts.length,
    taskCount: tasks.length,
    artifacts,
  };

  files.set("plan-manifest.json", JSON.stringify(manifest, null, 2) + "\n");

  for (const [relativePath, content] of files) {
    await writeAtomic(resolve(directory, relativePath), content.trimEnd() + "\n");
  }

  const current: CurrentProjectPlan = {
    version: 1,
    planId,
    status: "draft_ready",
    planDirectory: directory,
    manifestPath: resolve(directory, "plan-manifest.json"),
    discoverySessionId: session.sessionId,
    updatedAt: now,
  };

  await writeAtomic(currentPlanPath(workspaceDirectory), JSON.stringify(current, null, 2) + "\n");

  return { current, manifest, tasks };
}

export async function readProjectPlanArtifact(
  workspaceDirectory: string,
  relativePath: string,
  planId?: string,
): Promise<string> {
  const manifest = await loadProjectPlanManifest(workspaceDirectory, planId);
  if (!manifest) throw new Error("No project plan is available.");

  const artifact = manifest.artifacts.find((item) => item.relativePath === relativePath);
  if (!artifact) {
    throw new Error("Unknown project plan artifact: " + relativePath + ".");
  }

  const directory = planDirectory(workspaceDirectory, manifest.planId);
  const target = resolve(directory, artifact.relativePath);
  const relative = target.slice(directory.length).replaceAll("\\", "/");

  if (!relative.startsWith("/") || relative.includes("/../")) {
    throw new Error("Project plan artifact path escapes the plan directory.");
  }

  return readFile(target, "utf8");
}
