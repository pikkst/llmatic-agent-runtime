# LLMatic Agent Runtime

LLMatic is a local software-engineering runtime for AI coding agents. It connects an opened repository to a deterministic workflow for environment setup, project discovery, planning, implementation, validation, review, and task progression while keeping LLMatic runtime state outside the repository.

The default agent integration is Kilo Code, and the default direct-agent model is `kilo-auto/free`.

## Install

### VS Code Marketplace

After the Marketplace publisher is enabled, install LLMatic directly from VS Code:

1. Open **Extensions** with `Ctrl+Shift+X`.
2. Search for **LLMatic Agent Runtime**.
3. Select **Install**.
4. Open the repository or empty project folder you want to work with.
5. Run **LLMatic: Get Ready** from the Command Palette.

CLI equivalent:

```powershell
code --install-extension eventnexus.llmatic-agent-runtime
```

### VSIX fallback

Every tagged GitHub release also publishes a verified VSIX and release manifest.

Download the VSIX from the matching GitHub Release, then either use **Extensions → … → Install from VSIX…** or:

```powershell
code --install-extension .\llmatic-agent-runtime-0.2.0.vsix
```

## Requirements

- VS Code 1.105.0 or newer.
- Node.js available as `node`.
- Git for repository workflows.
- Kilo Code for the default coding-agent integration.

Repository-specific tools are detected during bootstrap. LLMatic does not silently install arbitrary software.

## Quick start

Open a project folder in VS Code and run:

```text
LLMatic: Get Ready
```

Get Ready:

```text
attach workspace outside repository
  -> verify/install bundled LLMatic runtime
  -> inspect required project tooling
  -> detect/connect Kilo Code
  -> verify Kilo MCP registration
  -> READY
```

Runtime/configuration state is stored in VS Code global extension storage rather than in the opened repository.

The same health state is visible in the LLMatic Activity Bar view:

```text
READY
NEEDS_SETUP
NEEDS_REPAIR
```

## Starting a new project

For an empty folder:

```text
LLMatic: Start Project Discovery
```

Discovery first asks what you want to build, then walks through product type, maturity, users, application shape, authentication, ownership, persistence, deployment, testing, and security.

Discovery remains private. It does not scaffold code or write tracked planning files.

When discovery is complete:

```text
LLMatic: Generate Project Plan
LLMatic: Review & Approve Project Plan
```

The private plan includes product requirements, user journeys, architecture, ADRs, data model, API contracts, security, testing, operations, roadmap, TASKS.md, and a dependency graph.

You can review artifacts, edit discovery decisions, request plan changes, and regenerate. Requested changes are inputs to the next versioned draft.

Only **Approve & Initialize** may materialize the exact approved plan into the repository.

Approval is bound to the plan ID, SHA-256 digest of the plan bundle, and SHA-256 digest of the discovery decisions.

## Existing repositories

For an existing repository, start with:

```text
LLMatic: Get Ready
```

LLMatic then recovers the engineering context instead of leaving you at a manual command menu:

```text
map repository
  -> detect current branch + working tree
  -> recover active LLMatic workflow
  -> inspect open pull request + CI
  -> detect canonical task source
  -> recover active task / ranked next-task candidates
  -> recommend the next engineering action
  -> open Agent Chat
```

The repository map records file structure, TypeScript/JavaScript AST symbols and import edges in LLMatic's external workspace cache.

The LLMatic Activity Bar shows the map counts, recovered task/workflow/PR state and the recommended next action. **Agent Chat** keeps a persistent multi-turn conversation and shows model/tool activity while the agent works.

Useful actions:

```text
LLMatic: Open Agent Chat
LLMatic: Refresh Repository Context
LLMatic: Doctor
```

Runtime state and the repository intelligence cache stay outside tracked repository files.

### Repository constitution

Existing repositories are also analyzed for project-specific engineering rules. LLMatic distinguishes:

```text
facts
explicit repository rules
inferred conventions
human-approved rules
rule proposals awaiting review
```

Explicit rules keep source-path/line provenance. Inferred conventions are advisory and cannot become blocking policy by themselves.

Repeated review findings may become **rule proposals** after three separate occurrences. A proposal is never enforced until you explicitly approve it with:

```text
LLMatic: Review Repository Rule Proposals
```

Inspect the current policy with:

```text
LLMatic: Show Repository Rules
```

See [Repository Constitution and Engineering Policy](docs/REPOSITORY_CONSTITUTION.md) for the provenance and human-control model.

## Task sources

LLMatic task workflows do not require Jira.

By default, task sources are auto-detected. You can explicitly select a canonical source with the VS Code setting `llmatic.taskSource`:

```text
auto | jira | markdown | github
```

This matters when a repository contains both `TASKS.md` and a live Jira project.

For VS Code, the preferred setup is workspace-specific and browser-first:

```text
LLMatic: External Connections
LLMatic: Connect Jira Workspace
```

When the LLMatic OAuth broker is configured, **Continue with Atlassian** opens the browser, completes Atlassian OAuth 2.0 (3LO), discovers the authorized Jira sites and lets you select the project without copying an API token. Each repository/workspace stores its own Jira profile and workspace-ID-scoped credential in VS Code SecretStorage. This allows separate VS Code windows such as Snapycall and Krunditark to connect to different Jira sites/projects without sharing credentials or queue policy.

Manual Jira credentials remain an explicit fallback. The OAuth broker keeps the Atlassian client secret outside the VSIX and handles rotating refresh tokens; deployment guidance is in `deploy/oauth-broker/README.md`.

Jira work ownership is explicit:

```text
assigned_only   # team-safe default: only tasks assigned to current Jira user
project_queue   # explicit solo/full-project mode
```

In `assigned_only`, custom JQL cannot remove the current-user ownership restriction, and starting/validating another user's Jira task is rejected. In `project_queue`, the queue must be explicitly scoped by a Jira project key or custom JQL.

Fallback settings remain available:

```text
llmatic.jiraProjectKey
llmatic.jiraRecoveryJql
llmatic.jiraWorkMode
```

With Jira selected, LLMatic preserves Jira Rank order, filters dependency-incomplete candidates for deterministic `task next`, and exposes the live eligible candidate set to Agent Chat. The Kilo model reasons only over the allowed queue instead of guessing Jira state.

Auto-detection fallback order remains:

```text
TASKS.md / Tasks.md / TODO.md
  -> Jira when configured
  -> GitHub Issues when GitHub CLI is authenticated
  -> manual workflow references
```

Canonical CLI:

```text
llmatic task detect
llmatic task list
llmatic task next
llmatic task get <reference>
llmatic task start <reference>
llmatic task validate
llmatic task comment <reference> --text "..."
llmatic task transition <reference> --to <transition>
llmatic task complete --evidence "..."
```

Markdown task sources work fully offline and preserve unrelated document content.

## Review and fix loop

LLMatic supports a deterministic engineering loop:

```text
task
  -> implementation
  -> local validation
  -> structured review
  -> blocking findings?
       yes -> FIXING -> validate -> re-review
       no  -> READY_TO_PUSH
```

Useful commands:

```text
LLMatic: Open Agent Chat
LLMatic: Run Code Review
LLMatic: Run Review / Fix Loop
```

Review uses changed-files-first context. Review results are schema-validated before workflow state changes. When no task workflow is active, Review / Fix Loop can run in ad-hoc existing-repository mode without inventing workflow transitions.

The VS Code review path runs three evidence-driven lenses:

```text
General Engineering Review
Bug Hunter
Security
```

Findings remain visible in Agent Chat. When a finding is a concrete violation of an explicit or human-approved repository rule, it includes the rule ID and source provenance.

For pull-request preparation, use:

```text
LLMatic: Generate PR Draft
```

The draft is generated from captured task/workflow/check/review/security/architecture/rule evidence. Missing evidence is marked as not captured rather than invented.

When recovery finds a failing GitHub PR, Agent Chat can read PR check state and bounded failed GitHub Actions logs through read-only tools before proposing a fix.

### Reviewing another engineer's pull request

Use:

```text
LLMatic: Review External Pull Request
```

Enter the target pull-request number, URL, or branch reference. LLMatic reads the target PR metadata, changed files, unified diff, CI state, reviews, comments, and bounded inline review threads, then runs the same evidence-driven General Engineering, Bug Hunter, Security, and Repository Constitution review policy without selecting the PR author's task or changing Jira/workflow ownership.

The resulting Markdown review is shown before any remote mutation. You can copy the draft or explicitly publish it as a GitHub review comment. Publication requires the dedicated `pullRequestReview` permission and a modal confirmation; reviewing the PR itself remains read-only.

## Living architecture

Projects initialized from an approved LLMatic plan include a living-architecture gate.

Changes to architecture-sensitive areas must keep the corresponding planning contracts synchronized. Current impact areas include architecture, API contracts, database/schema, security, testing, and task graph/roadmap.

For example:

```text
API route change
  -> API_CONTRACTS.md or canonical contract update
  -> automated test update

schema/migration change
  -> DATA_MODEL.md update

authorization change
  -> SECURITY.md update
```

A model review cannot override unresolved deterministic architecture drift.

## Kilo Code integration

LLMatic installs and verifies its bundled MCP runtime in versioned VS Code global storage and registers that stable runtime path in Kilo Code's global MCP configuration.

If Kilo Code is installed during onboarding, LLMatic resumes Get Ready automatically and reconciles the MCP registration.

The default model is:

```text
kilo-auto/free
```

Change it with the VS Code setting:

```text
llmatic.agentModel
```

Before first Auto Free use, LLMatic displays a data-handling warning. Do not send confidential source code to a model/provider whose data-handling terms are unsuitable for the repository.

The Kilo Gateway API key is **not** required for Kilo Code MCP connectivity or runtime readiness. LLMatic can also use Kilo's anonymous access for `kilo-auto/free` and explicit `:free` models when `llmatic.allowAnonymousKiloFree` is enabled.

For paid/authenticated Gateway access use:

```text
LLMatic: External Connections
LLMatic: Connect Kilo Gateway
```

LLMatic can open `app.kilo.ai` in your browser so you can create a Gateway API key, then prompts you to paste it into VS Code SecretStorage. Kilo does not currently expose a documented direct Gateway OAuth handoff for third-party clients, so browser-assisted key creation is the safe fallback while Auto Free remains keyless.

## Safety boundaries

LLMatic intentionally separates analysis/automation from consequential actions.

The built-in fix agent is constrained to repository-contained text changes and does not receive arbitrary shell, package-install, Git push, PR merge, deployment, or remote-database mutation capabilities.

Project initialization does not automatically push Git, create or merge a PR, mutate a remote database, or deploy.

Gateway credentials are stored in VS Code SecretStorage.

## Releases and updates

Semantic tags such as `v0.2.0` run the release pipeline, package the VSIX, verify release metadata and hashes, execute clean-install acceptance, and publish a GitHub Release.

Update commands:

```text
LLMatic: Check for Updates
LLMatic: Install Latest Update
```

Marketplace publishing is gated separately. Future automated releases use GitHub OIDC to authenticate to Microsoft Entra ID, then `vsce publish --azure-credential`; no Marketplace PAT or Entra client secret is stored in the repository.

## Troubleshooting

Run:

```text
LLMatic: Doctor
```

If the bundled runtime is stale or damaged:

```text
LLMatic: Repair Runtime
```

If Kilo integration needs reconciliation:

```text
LLMatic: Connect Kilo Code Globally
```

If setup is incomplete:

```text
LLMatic: Get Ready
```

For bugs, include the LLMatic output-channel diagnostics, VS Code version, LLMatic version, operating system, and reproducible steps.

## Development

Install dependencies and run the canonical local CI:

```bash
pnpm install
pnpm run ci:local
```

Important acceptance commands:

```bash
pnpm product:acceptance
pnpm vscode:acceptance
pnpm release:acceptance v0.2.0 <commit-sha>
```

The milestone roadmap is maintained in [docs/ROADMAP.md](docs/ROADMAP.md).

Marketplace publisher and Microsoft Entra automated-publishing setup are documented in [docs/marketplace-publishing.md](docs/marketplace-publishing.md).

## License

MIT.
