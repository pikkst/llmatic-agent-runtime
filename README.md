# LLMatic Agent Runtime

Universal local software-engineering runtime for coding agents.

LLMatic Agent Runtime gives coding agents a deterministic, repository-aware capability layer instead of forcing every model to rediscover project-specific commands, tools, and quality gates.

## Current milestone

M3 — Local Validation Orchestration

Implemented:

- repository and toolchain detection
- package-manager detection
- technology detection
- structured capability discovery
- `llmatic init`
- `llmatic detect`
- `llmatic doctor`
- persistent workflow state and checkpoints
- validated workflow transitions
- permission-aware capability execution
- `llmatic run <capability>`
- `llmatic workflow start/status/transition`
- automatic required-gate orchestration through `llmatic validate`
- canonical local/hosted CI pipeline

## Architecture

Coding agents are clients of the runtime.

Kilo Code, Codex, Claude Code, Cline, local LLMs, or other clients should eventually access the same capabilities through CLI and MCP interfaces.

A logical capability such as test, lint, typecheck, build, or CI is resolved by the runtime to repository-specific tooling.

The runtime owns workflow state and quality-gate decisions so agents do not need to reconstruct engineering process rules from prompts.

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

Run the CLI from the workspace:

    node apps/cli/dist/index.js detect
    node apps/cli/dist/index.js doctor
    node apps/cli/dist/index.js init
    node apps/cli/dist/index.js status
    node apps/cli/dist/index.js validate

## Roadmap

Next milestones add:

1. tool registry and controlled installers
2. Git adapter
3. repository intelligence and AST indexing
4. GitHub adapter
5. MCP server
6. task-provider adapters such as Jira
7. Docker, Supabase, Python, and local-LLM packs
8. automated code-review and remote-CI orchestration
9. controlled PR/merge/deploy actions

See docs/architecture.md, docs/security-model.md, docs/workflow-state.md, and docs/orchestration.md.
