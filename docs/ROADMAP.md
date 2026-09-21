# LLMatic Agent Runtime roadmap

This file is the canonical forward milestone plan after M19.

## M19 — Release Acceptance

Status: completed.

Goal: prove that a tagged candidate contains a valid VS Code extension, verified runtime, valid release manifest and zero-repository-footprint package before GitHub Release publication.

## M20 — Universal Task Sources

Status: completed.

Goal: remove Jira as a required workflow assumption.

Canonical task abstraction:

- Jira
- Markdown task files such as TASKS.md / Tasks.md / TODO.md
- GitHub Issues
- Manual tasks
- provider auto-detection

The workflow engine must consume one normalized task contract regardless of source.

Expected commands:

    llmatic task detect
    llmatic task list
    llmatic task next
    llmatic task get <id>
    llmatic task start <id>
    llmatic task complete <id>

Markdown must be a first-class offline task source and preserve unrelated document content while updating task status/evidence.

## M21 — Greenfield Discovery Engine

Status: completed.

Goal: if the repository/project is empty or the user explicitly starts a new project, planning begins before repository mutation.

Discovery is adaptive rather than a fixed questionnaire.

Question UI must support:

- recommended option
- alternatives
- custom answer
- not sure / recommend for me
- let LLMatic decide, with documented rationale
- follow-up questions based on previous answers

The recommendation engine should use best-practice policy packs and project context rather than hardcoded framework preferences.

Core discovery areas:

- product/problem
- target users
- MVP vs prototype vs production
- application type
- authentication
- tenancy/organizations
- data model needs
- integrations
- scale
- hosting/deployment
- security/compliance
- testing/quality expectations

No implementation/scaffold/package install is allowed before approval.

## M22 — Project Planning Engine

Status: completed.

Goal: turn approved discovery decisions into an engineering plan.

Generated planning artifacts:

- product brief
- requirements
- user journeys
- architecture
- ADRs
- data model
- API contracts
- security model
- testing strategy
- observability/operations strategy
- roadmap/phases
- task graph
- dependency graph
- TASKS.md or selected task-provider representation

Planning artifacts stay in private LLMatic workspace storage until explicit project approval.

## M23 — Approval & Initialization

Status: completed.

Goal: require a human decision before the generated plan becomes repository state.

Canonical state flow:

    EMPTY_REPO
      -> IDEA_CAPTURED
      -> REQUIREMENTS_DRAFTED
      -> ARCHITECTURE_DRAFTED
      -> ROADMAP_DRAFTED
      -> TASK_GRAPH_DRAFTED
      -> PLAN_REVIEW
      -> APPROVED
      -> PROJECT_INITIALIZING
      -> FOUNDATION_VALIDATION
      -> READY_FOR_IMPLEMENTATION

PLAN_REVIEW actions:

- Edit Decisions
- Regenerate Plan
- Request Changes
- Approve & Initialize

Before APPROVED:

- repositoryWrite: deny
- packageInstall: deny
- databaseMigration: deny
- gitPush: deny
- createPullRequest: deny
- deploy: deny

After approval, LLMatic materializes the approved documentation/scaffold, bootstraps tools, runs local validation and selects the first unblocked task.

## M24 — Living Architecture

Status: completed.

Goal: keep code, architecture, contracts and task graph synchronized throughout implementation.

Every material code change should evaluate impacts on:

- architecture
- ADRs
- API contracts
- database/schema
- security model
- testing strategy
- roadmap
- dependency graph
- task definitions

Definition of Done becomes broader than tests/build:

    implementation
    tests
    documentation impact
    architecture impact
    API contract impact
    schema impact
    security impact
    task-graph impact

The runtime should update affected artifacts or surface an explicit approval-required change instead of silently letting documentation drift.

## Guiding rule

Greenfield projects follow:

    discovery -> planning -> review -> explicit approval -> initialization -> implementation

LLMatic may recommend and explain best-practice choices, but the user controls consequential project decisions.

## M25 — End-to-End Product Acceptance

Status: completed.

Goal: prove the assembled product lifecycle as one executable acceptance path rather than relying only on isolated package tests.

Canonical acceptance flow:

    empty Git repository
      -> discovery
      -> ready_for_planning
      -> versioned private plan
      -> exact human approval
      -> controlled initialization
      -> READY_FOR_IMPLEMENTATION
      -> first dependency-unblocked task selected
      -> implementation drift
      -> living-architecture gate blocks
      -> contract/test synchronization
      -> living-architecture gate clears
      -> completed first task reveals next dependency-unblocked task

The acceptance gate runs locally and in hosted CI through:

    pnpm product:acceptance

A release candidate is not product-ready if this lifecycle gate fails.

## M26 — First Real Release & Clean-Install Acceptance

Status: in progress.

Goal: prove the packaged VSIX as a real installed production extension before the first public semantic release.

Acceptance path:

    accepted VSIX
      -> isolated VS Code profile
      -> install VSIX through VS Code CLI
      -> discover installed extension
      -> ExtensionMode.Production
      -> activate installed extension
      -> verify critical command registrations
      -> verify zero-repository footprint

The acceptance environment uses the minimum supported VS Code version:

    1.105.0

Canonical command:

    pnpm vscode:acceptance

Hosted CI runs this as a separate job after the ordinary CI/release acceptance artifact is produced.

The tag-driven Release workflow must also pass this gate before GitHub Release publication.

First release target:

    v0.1.0

The repository connector cannot create Git tags. Once main is green, the only manual release trigger is:

    git pull --ff-only origin main
    git tag -a v0.1.0 -m "LLMatic Agent Runtime v0.1.0"
    git push origin v0.1.0
