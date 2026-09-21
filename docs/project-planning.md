# Private project planning

M22 turns a completed discovery session into a versioned engineering-plan draft.

## Generation

Use:

    LLMatic: Generate Project Plan

or MCP:

    llmatic_plan_generate

Generation requires discovery status:

    ready_for_planning

## Generated artifacts

Each plan contains:

- PRODUCT_BRIEF.md
- REQUIREMENTS.md
- USER_JOURNEYS.md
- ARCHITECTURE.md
- adr/ADR-001-application-architecture.md
- adr/ADR-002-persistence.md
- adr/ADR-003-identity-tenancy.md
- DATA_MODEL.md
- API_CONTRACTS.md
- SECURITY.md
- TESTING.md
- OPERATIONS.md
- ROADMAP.md
- TASKS.md
- dependency-graph.json
- plan-manifest.json

The task graph is adapted to discovery decisions. Authentication, tenancy, persistence, UI and deployment tasks are included only when relevant.

## Versioning

Every generation creates a new immutable draft directory:

    <managed-workspace>/planning/plans/<plan-id>/

The active draft pointer is:

    <managed-workspace>/planning/current-plan.json

Regeneration updates only the active pointer and preserves earlier drafts.

## Review

Use:

    LLMatic: Review Project Plan

The user can open any private artifact in VS Code or reveal the private plan folder.

Agents can use:

- llmatic_plan_status
- llmatic_plan_generate
- llmatic_plan_read_artifact

## Boundary before M23

M22 only produces private draft artifacts.

It does not:

- write planning documents into the repository
- scaffold application source
- install dependencies
- create database migrations
- push Git
- create/merge PRs
- deploy

The next milestone introduces explicit plan review and approval before materialization/initialization.
