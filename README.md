# LLMatic Agent Runtime

Universal local software-engineering runtime for coding agents.

LLMatic Agent Runtime gives coding agents a deterministic, repository-aware capability layer instead of forcing every model to rediscover project-specific commands, tools, and quality gates.

## Current milestone

M5 — Git Adapter

Implemented:

- repository, package-manager, technology, and tool detection
- structured capability execution
- persistent workflow state and checkpoints
- state-aware local validation orchestration
- canonical local/hosted CI pipeline
- agent-neutral tool registry with controlled installers
- protected Git adapter
- explicit-path staging
- staged-only commits
- permission-gated push
- workflow-aware branch creation and push
- generic ACTION checkpoints for auditable external operations

## Useful commands

    llmatic detect
    llmatic doctor
    llmatic status
    llmatic validate

    llmatic tools list
    llmatic tools install pnpm --approve

    llmatic git status
    llmatic git branch feature/TASK-123-description
    llmatic git stage src/file.ts
    llmatic git commit -m "feat: implement TASK-123"
    llmatic git push --approve

    llmatic workflow branch feature/TASK-123-description
    llmatic workflow validate
    llmatic workflow push --approve

## Architecture

Coding agents are clients of the runtime.

Kilo Code, Codex, Claude Code, Cline, local LLMs, or other clients should eventually access the same deterministic operations through CLI and MCP interfaces.

Core owns workflow semantics. Tool installation and Git operations live in separate adapter packages that depend on core permission/state contracts.

## Development

Requirements:

- Node.js 20+
- pnpm

Install dependencies:

    corepack enable
    pnpm install

Validate:

    pnpm ci:local

Build:

    pnpm build

## Roadmap

Next milestones add:

1. repository intelligence and AST indexing
2. GitHub adapter
3. MCP server
4. task-provider adapters such as Jira
5. Docker, Supabase, Python, and local-LLM tool packs
6. automated code-review and remote-CI orchestration
7. controlled PR/merge/deploy actions

See docs/architecture.md, docs/security-model.md, docs/workflow-state.md, docs/orchestration.md, docs/tools.md, and docs/git-adapter.md.
