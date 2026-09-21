# LLMatic Agent Runtime

Universal local software-engineering runtime for coding agents.

## Current milestone

M14 — Automated Review / Fix Loop

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

    LLMatic: Bootstrap Workspace

It derives tool requirements from repository signals, offers only registry-backed controlled installers, reconciles Kilo MCP, and leaves tracked repository files untouched.

See docs/bootstrap-remediation.md.

## VS Code commands


    LLMatic: Bootstrap Workspace
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
