# Changelog

## 0.3.0 — Unreleased

- Started the v0.3.0 development line after the accepted v0.2.0 release.
- External pull-request review is the first active milestone: explicitly review another engineer's PR without changing Jira ownership or workspace task recovery state.
- Added bounded read-only external PR context for Agent Chat, including metadata, changed files, unified diff, CI state, reviews and comments.
- Added an explicit `LLMatic: Review External Pull Request` flow that runs General, Bug Hunter and Security lenses with Repository Constitution context without mutating Jira ownership or the active workflow.
- External PR context now includes bounded inline review threads with path/line and resolved/outdated state so the reviewer can account for existing code-review discussion.
- Review results can be copied as a Markdown draft or published as a GitHub review comment only after explicit modal confirmation and the dedicated `pullRequestReview` permission.
- Pull requests without CI checks are treated as `ciState=none` instead of failing review context loading, and bounded/truncated diffs are explicitly reported as partial review coverage with omitted changed files.
- External PR changed-file inventory is read through paginated GitHub REST results so review coverage does not silently stop at a single GraphQL file page.
- Agent Chat no longer receives or downloads raw external PR diff bytes; it gets secret-policy-filtered metadata only, while the explicit structured review path keeps per-file diff access behind the existing sensitive-path guard. Inline review threads on sensitive paths are also excluded from model context.
- External review now rejects pull requests from a different repository than the opened workspace, preventing local Constitution/source context from being applied to an unrelated repository.
- Structured review `read_file` calls now read immutable file content from the target PR head SHA through GitHub instead of the active local branch, preserving external-review isolation without checkout or worktree mutation.
- Review metadata, diff capture and publication are bound to one PR head SHA; if the PR changes during capture or before publication, LLMatic aborts and requires a refreshed review instead of posting stale findings.
- External PR findings are now scope-gated: only documented DoD/acceptance violations, concrete changed-code defects, and explicit/human-approved repository-rule violations survive into the final report.
- Nice-to-have features, optional refactors, cleanup/style preferences, speculative future work and unsupported performance ideas are filtered out; undocumented DoD requirements are discarded.
- Concrete defect/rule findings must map to a real changed diff line and are previewed/published as GitHub inline comments; DoD gaps without a valid inline target remain summary-only.
- Published review summaries are deterministic and based on validated findings rather than free-form model suggestion prose.
- Added visible `External PR Review` and `Auto Review Agent` actions to the LLMatic Runtime Status view.
- Added a repository-bound local Auto Review Agent that watches every two minutes while VS Code is open, baselines existing PRs on enable, automatically reviews new or updated review-ready PR heads, waits for drafts to become ready, and never auto-publishes review comments.

## 0.2.0

- Added a persistent LLMatic Agent Chat webview with multi-turn user/assistant history and visible tool activity.
- Added automatic existing-repository mapping with file, AST symbol and import counts.
- Added workspace recovery across active workflow state, Git branch/worktree, open pull request, CI state and task sources.
- Added deterministic next-action recommendations such as continue workflow, fix failing PR, continue local changes, continue active task or start the next unblocked task.
- Added live agent task tools for canonical Jira, Markdown and GitHub task sources instead of relying only on prompt snapshots.
- Added Jira recovery queues ordered by Jira Rank with dependency-aware next-task selection.
- Added configurable canonical task source plus optional Jira project/JQL recovery scope.
- Added ad-hoc Review / Fix Loop support for existing repositories without an active CODE_REVIEW workflow.
- Run Gateway Agent now opens Agent Chat rather than a one-shot modal prompt.
- Added a provenance-based Repository Constitution that learns explicit project rules from repository docs/tooling while keeping inferred conventions advisory.
- Added human-reviewed rule proposals; repeated review findings require three separate occurrences before LLMatic proposes a durable rule, and proposals never self-activate.
- Added General, Bug Hunter and Security review lenses with rule-ID/source attribution for concrete policy violations.
- Persist the latest structured review and show findings in Agent Chat.
- Added read-only open-PR/CI diagnostics including bounded failed GitHub Actions logs.
- Added provider-neutral task workflow start and safe local workflow advancement tools for Agent Chat.
- Added evidence-backed PR draft generation covering task/DoD, validation, review, security, architecture and repository rules without fabricating missing evidence.
- Added workspace-specific Jira connection profiles so separate VS Code workspaces can use different Jira sites/projects and credentials.
- Added team-safe Jira `assigned_only` mode as the default and explicit `project_queue` mode for solo/full-project queues.
- Enforced Jira task ownership at workflow start/validation, including when custom recovery JQL is configured.
- Added green/yellow/red semantic status colors across Runtime Status and Agent Chat for healthy, attention and blocking/error states.
- Added a reusable External Connections registry and VS Code Connection Center for browser/manual provider onboarding.
- Added browser-first Atlassian OAuth 2.0 (3LO) support through a server-side LLMatic OAuth broker, including Jira site/project discovery and rotating-token refresh.
- Added browser-assisted Kilo Gateway key discovery plus anonymous `kilo-auto/free` / `:free` access without a key.

## 0.1.2

- Added a visible Kilo Gateway API key action to the LLMatic Activity Bar.
- Store and replace the Gateway key through a password input backed by VS Code SecretStorage.
- Run Gateway Agent and Review / Fix Loop now offer secure key setup automatically when the key is missing instead of failing with a dead-end error.
- Clarified that the Gateway key is optional for Kilo MCP connectivity and required only for LLMatic direct agent/review orchestration.
- Refresh the LLMatic key status immediately after storing or clearing the credential.

## 0.1.1

- Applied requested plan changes to regenerated private drafts.
- Added product-specific planning for requirements, user journeys, data model, API contracts, task wording, ownership rules, and dependency graph.
- Added Task-domain regression coverage for create/view/edit/complete/delete planning flows.
- Made quality/regression work depend on the completed end-to-end journey for full-stack projects.
- Resumed Get Ready automatically when Kilo Code is installed during onboarding.
- Added Marketplace-ready metadata, installation documentation, support guidance, and trusted-publishing preparation.

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

## M23 — Approval and initialization

- Added digest-bound human approval for the exact current plan and discovery decisions.
- Added PLAN_REVIEW actions for edit decisions, regenerate, request changes and approve/initialize.
- Editing a decision clears dependent later discovery answers and invalidates approval.
- Approved initialization is greenfield-only and refuses to overwrite existing project files.
- Materialization verifies approved planning bytes before selecting the first dependency-unblocked task.
- Failed initialization rolls back files created by that attempt.
- Added read-only MCP approval/lifecycle status; MCP cannot self-approve or initialize.

## M24 — Living architecture

- Added deterministic changed-file architecture impact classification.
- Living-architecture enforcement activates only for initialized approved-plan repositories.
- Code review now blocks on unresolved architecture/API/schema/security/testing/task-graph synchronization.
- Review/fix loop receives concrete synchronization instructions for unresolved impact areas.
- VS Code review output shows code findings and living-architecture synchronization evidence separately.

## M26 — Clean-install acceptance

- Added real VSIX installation acceptance using VS Code Extension Host.
- Acceptance runs against the minimum supported VS Code 1.105.0.
- Verifies VS Code loads the extension from the isolated VSIX extensions directory rather than the source-development path, then activates it successfully.
- Verifies critical LLMatic commands are registered from the installed VSIX.
- Verifies extension activation keeps the opened repository free of LLMatic runtime/config files.
- Added the clean-install gate to hosted CI and the tag-driven release workflow.
