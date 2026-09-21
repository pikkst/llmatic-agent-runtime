# Changelog

## 0.1.0

- Initial VS Code extension.
- Zero-repository workspace storage.
- Global Kilo MCP registration.
- Bundled LLMatic MCP runtime.
- VS Code SecretStorage integration.
- LLMatic Doctor health checks.

## M13 — Gateway agent orchestrator

- Added a direct Kilo Gateway coding-agent command.
- Default model is `kilo-auto/free`.
- Added an Auto Free data-handling warning before first use.
- Added repository-contained safe file tools and quality-gate tool loops.
- Gateway credentials remain in VS Code SecretStorage.
- Direct agent has no push, PR, merge, deployment, package-install, database, or arbitrary shell tools.

## M14 — Review / fix loop

- Added structured Kilo Gateway code review with blocking and non-blocking findings.
- Added workflow-aware CODE_REVIEW to FIXING or READY_TO_PUSH transitions.
- Added automated blocking-finding fix, local validation, and re-review loop.
- Review uses changed-files-first context and bounded repository read/diff tools.
- Added VS Code commands for one-shot review and automated review/fix loop.

## Carried forward — Workspace bootstrap

- Restored the repository-aware Bootstrap Workspace command from the original PR #13 branch.
- Bootstrap derives required/recommended/optional tools from repository signals.
- Automatic remediation remains restricted to Tool Registry installers and explicit user approval.
- Bootstrap preserves the zero-repository-footprint boundary.

## M15 — Runtime lifecycle and repair

- Bundled MCP runtime now ships with a SHA-256 manifest.
- Runtime is installed into versioned VS Code global storage rather than referenced from the extension install directory.
- Kilo MCP points to the verified installed runtime.
- Doctor validates runtime integrity.
- Added `LLMatic: Repair Runtime` to restore corrupted/stale runtime bytes and reconcile Kilo MCP.

## M16 — Guided onboarding and health UI

- Added deterministic READY / NEEDS SETUP / NEEDS REPAIR evaluation.
- Added LLMatic Activity Bar Runtime Status view.
- Added `LLMatic: Get Ready` guided workspace/runtime/tool/Kilo setup flow.
- Status bar now uses the same canonical health state and routes non-ready states to Get Ready.
- Added one-time per-workspace onboarding prompt.
- Gateway API key remains optional and does not block runtime readiness.

## M17 — Release and update pipeline

- Added semantic-version release metadata and validation.
- Added tag-driven GitHub Release workflow.
- Release publishes a versioned VSIX plus SHA-256 release manifest.
- Added `LLMatic: Check for Updates` backed by validated GitHub release metadata.
- Update checks do not silently install or replace extension bytes.

## M18 — Verified self-update and extension-surface regression guard

- Restored the full VS Code activation entrypoint after detecting an M16 formatter-roundtrip truncation.
- Added a regression test that requires the activation entrypoint and critical commands to remain present.
- Added explicit Download & Install update flow.
- Release repository/tag/asset identity is checked before download.
- Downloaded VSIX size and SHA-256 must match release-manifest.json.
- Verified VSIX is staged only in versioned VS Code global storage.
- VS Code installation happens only after a user confirmation.
- No silent background update installation is performed.

## M19 — Release acceptance

- Added cross-platform release acceptance command.
- Acceptance opens the VSIX and verifies the packaged activation surface, runtime manifest and runtime bytes.
- Release publication is now gated by release acceptance.
- Added manual GitHub Release Acceptance workflow for pre-tag candidate validation.
- Added clean-install and future upgrade acceptance procedure.

## M21 — Greenfield discovery

- Added adaptive private project discovery.
- Added recommended/custom/not-sure/delegate answer paths.
- Recommendations store explicit rationale.
- Discovery progress persists outside the repository.
- Added New Project Discovery Activity Bar action and status command.
- No scaffold or tracked repository mutation is available from discovery.

## M22 — Project planning

- Added a versioned private project-planning engine.
- Generates product brief, requirements, user journeys, architecture, ADRs, data/API/security/testing/operations documents, roadmap, TASKS.md and dependency graph.
- Plan regeneration preserves older drafts and moves only the private current-plan pointer.
- Added Generate Project Plan and Review Project Plan VS Code commands.
- Added MCP plan status/generate/read-artifact tools.
- Planning remains outside the repository and has no approval/materialization path yet.

