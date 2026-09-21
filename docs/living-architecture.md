# Living architecture

M24 keeps implementation, architecture contracts and the task graph synchronized after project initialization.

## Activation

The deterministic gate is active only when both exist:

    docs/planning/APPROVED_PLAN.md
    TASKS.md

Repositories without the initialized LLMatic planning baseline retain the previous review behavior.

## Impact areas

### Architecture

Triggered by material workspace/package/tooling/deployment structure changes such as package manifests, workspace TypeScript configuration, Docker/Compose and CI workflow changes.

Resolution evidence:

- docs/planning/ARCHITECTURE.md
- or an ADR under docs/planning/adr/

### API contract

Triggered by API/routes/controllers/handlers/http/OpenAPI and apps/api changes.

Resolution evidence:

- docs/planning/API_CONTRACTS.md
- packages/contracts/
- canonical OpenAPI contract

### Schema

Triggered by migrations/schema/Supabase persisted-schema changes.

Resolution evidence:

- docs/planning/DATA_MODEL.md

### Security

Triggered by authentication, authorization, permission, RBAC, RLS or policy changes.

Resolution evidence:

- docs/planning/SECURITY.md

### Operations

Triggered by deployment/infrastructure paths, Docker/Compose, and deployment/release/production workflow changes.

Resolution evidence:

- docs/planning/OPERATIONS.md

### Testing

Triggered by application source-code changes.

Resolution evidence:

- changed automated test/spec files

### Task graph

Triggered when architecture/API/data/security planning documents or ADRs change.

Resolution evidence:

- TASKS.md
- docs/planning/ROADMAP.md
- or docs/planning/dependency-graph.json

## Review state machine

The code-review model and deterministic impact engine are independent evidence sources.

Total blocking review items are:

    blocking code findings
      + unresolved living-architecture impact areas

Therefore a model response with zero findings cannot move CODE_REVIEW to READY_TO_PUSH when a required synchronization artifact is missing.

The review/fix loop receives concrete instructions for both code defects and unresolved synchronization areas.

## Checkpoints

Each review records:

    provider: architecture-impact
    action: impact.review

with required/unresolved counts and unresolved area names.

This keeps the synchronization gate auditable in persistent workflow state.


## MCP inspection

Agents can inspect the deterministic gate before review with:

    llmatic_architecture_impact

This tool is read-only. It reads the Git working-tree path set and returns required/resolved impact areas plus concrete synchronization recommendations.
