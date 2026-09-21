# LLMatic Agent Runtime

Universal local software-engineering runtime for coding agents.

## Current milestone

M17 — Release & Update Pipeline

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

Update command:

    LLMatic: Check for Updates

See docs/release-update.md.

## VS Code commands


    LLMatic: Bootstrap Workspace
    LLMatic: Check for Updates
    LLMatic: Run Gateway Agent
    LLMatic: Run Code Review
    LLMatic: Run Review / Fix Loop

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
