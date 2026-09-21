# LLMatic Agent Runtime

Universal local software-engineering runtime for coding agents.

LLMatic Agent Runtime gives coding agents a deterministic, repository-aware capability layer instead of forcing every model to rediscover project-specific commands, tools, and quality gates.

## Current milestone

M1 — Local Runtime Foundation

Implemented in the bootstrap:

- repository detection
- package-manager detection
- technology detection
- standard capability discovery
- llmatic init
- llmatic detect
- llmatic doctor
- permission-aware runtime configuration
- initial architecture and security model
- CI validation

## Architecture

Coding agents are clients of the runtime.

Kilo Code, Codex, Claude Code, Cline, local LLMs, or other clients should eventually access the same capabilities through CLI and MCP interfaces.

A logical capability such as test, lint, typecheck, build, or CI is resolved by the runtime to repository-specific tooling.

## Development

Requirements:

- Node.js 20+
- pnpm

Install dependencies:

    corepack enable
    pnpm install

Validate:

    pnpm run ci

Build:

    pnpm build

Run the CLI from the workspace:

    node apps/cli/dist/index.js detect
    node apps/cli/dist/index.js doctor
    node apps/cli/dist/index.js init

## Roadmap

Next milestones add:

1. persistent workflow state and checkpoints
2. capability execution
3. tool registry and controlled installers
4. Git adapter
5. repository intelligence and AST indexing
6. GitHub adapter
7. MCP server
8. task-provider adapters such as Jira
9. Docker, Supabase, Python, and local-LLM packs
10. review and remote-CI orchestration

See docs/architecture.md and docs/security-model.md.
