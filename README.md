# LLMatic Agent Runtime

Universal local software-engineering runtime for coding agents.

## Current milestone

M22 — Project Planning Engine

LLMatic now supports:

    implementation
      -> local validation
      -> structured review
      -> blocking findings?
           yes -> FIXING -> validation -> re-review
           no  -> READY_TO_PUSH

Review results are schema-validated before workflow state changes.

## Default model

Direct implementation and review both default to:

    kilo-auto/free

The model is configurable through llmatic.agentModel.

## Workspace bootstrap

The carried-forward bootstrap flow from PR #13 is available as:

    LLMatic: Get Ready
    LLMatic: Bootstrap Workspace
    LLMatic: Repair Runtime

It derives tool requirements from repository signals, offers only registry-backed controlled installers, reconciles Kilo MCP, and leaves tracked repository files untouched.

See docs/bootstrap-remediation.md.

## Runtime lifecycle

The bundled MCP server is SHA-256 verified and installed into versioned VS Code global storage. Kilo MCP points to that stable runtime path.

Repair command:

    LLMatic: Repair Runtime

See docs/runtime-lifecycle.md.

## Guided onboarding

The extension exposes one canonical runtime state:

    READY
    NEEDS_SETUP
    NEEDS_REPAIR

Use:

    LLMatic: Get Ready

The guided flow attaches the workspace externally, verifies/repairs the runtime, checks required repository tools, and reconciles Kilo MCP when configured.

The same state is visible in the status bar and the LLMatic Activity Bar view.

## Releases and updates

Semantic version tags (`vX.Y.Z`) run the full validation/VSIX pipeline and publish a GitHub Release containing a versioned VSIX and `release-manifest.json` with SHA-256 metadata.

Update commands:

    LLMatic: Check for Updates
    LLMatic: Install Latest Update

See docs/release-update.md.

## VS Code commands

    LLMatic: Bootstrap Workspace
    LLMatic: Check for Updates
    LLMatic: Run Gateway Agent
    LLMatic: Run Code Review
    LLMatic: Run Review / Fix Loop

## Verified self-update

An update is installed only after validating release identity, downloading the exact declared VSIX, checking its byte size and SHA-256, and receiving explicit user confirmation.

The verified VSIX is staged under VS Code global storage, never inside the opened repository.

A regression test also verifies that the VS Code `activate()` entrypoint and critical command registrations remain present.

## Release acceptance

Before a tagged GitHub Release can publish, M19 now opens the candidate VSIX and verifies the packaged extension activation surface, release manifest, runtime hash/size and zero-repository-footprint boundary.

Local command:

    pnpm release:acceptance v0.1.0 <commit-sha>

See docs/release-acceptance.md.

## Safety

The reviewer is read-only and receives changed-files-first context. Sensitive paths are filtered.

The fix agent remains constrained:

- repository-contained text changes only
- no arbitrary shell
- no package install
- no Git push
- no PR/merge
- no database mutation
- no deploy
- no self-approval of ask permissions

Gateway credentials remain in VS Code SecretStorage.

## Existing platform

- zero-repo VS Code workspace state
- VSIX packaging and Doctor
- global Kilo MCP registration
- persistent workflow state
- local CI
- Git/GitHub/Jira adapters
- repository AST intelligence
- Docker/Supabase/Python/Ollama tool packs
- direct Kilo Gateway coding agent

See docs/review-fix-loop.md.

## Roadmap

The canonical milestone roadmap is maintained in `docs/ROADMAP.md`.

## Universal task sources

LLMatic task workflows no longer require Jira.

Canonical CLI:

    llmatic task detect
    llmatic task list
    llmatic task next
    llmatic task get <reference>
    llmatic task start <reference>
    llmatic task validate
    llmatic task comment <reference> --text "..."
    llmatic task transition <reference> --to <transition>
    llmatic task complete --evidence "..."

Auto-detection order:

    TASKS.md / Tasks.md / TODO.md
      -> Jira when configured
      -> GitHub Issues when GitHub CLI is authenticated
      -> manual workflow references

Markdown tasks are fully offline and preserve unrelated document content while updating task-local status/notes.

## Greenfield discovery

New or empty projects can start with:

    LLMatic: Start Project Discovery

Discovery is adaptive and supports:

- recommended best-practice option
- normal alternatives
- Custom…
- Not sure — explain recommendation
- Let LLMatic decide

Every delegated/recommended choice stores its rationale. Discovery state is persisted only under the managed LLMatic workspace:

    <globalStorage>/workspaces/<workspace-id>/planning/discovery.json

Cancelling the wizard pauses discovery without losing answered decisions.

M21 never scaffolds source code, installs packages, creates migrations, or writes planning files into the tracked repository.

## Private project planning

After discovery reaches `ready_for_planning`, use:

    LLMatic: Generate Project Plan
    LLMatic: Review Project Plan

M22 generates a versioned private draft containing:

- product brief
- requirements
- user journeys
- architecture
- proposed ADRs
- data model
- API contracts
- security model
- testing strategy
- observability/operations plan
- roadmap/phases
- TASKS.md
- dependency graph
- plan manifest

Storage:

    <globalStorage>/workspaces/<workspace-id>/planning/plans/<plan-id>/

The active draft is referenced by:

    <globalStorage>/workspaces/<workspace-id>/planning/current-plan.json

Regeneration creates a new plan version and preserves the previous draft.

M22 still cannot scaffold, install, migrate, push, create a PR, or deploy. M23 adds explicit human approval before any approved plan can become repository state.
