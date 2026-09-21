# LLMatic Agent Runtime

Universal local software-engineering runtime for coding agents.

LLMatic Agent Runtime gives coding agents a deterministic, repository-aware capability layer instead of forcing every model to rediscover project-specific commands, tools, and quality gates.

## Current milestone

M4 — Tool Registry

Implemented:

- repository and toolchain detection
- package-manager and technology detection
- structured capability discovery and execution
- persistent workflow state and checkpoints
- validated workflow transitions
- state-aware local validation orchestration
- canonical local/hosted CI pipeline
- agent-neutral tool registry
- structured tool probes
- permission-gated controlled installers
- `llmatic tools list`
- `llmatic tools install <tool>`

The initial registry detects Node.js, Git, pnpm, Docker, GitHub CLI, Deno, Supabase CLI, Python, uv, and Ollama. pnpm has the first controlled automated installer through Corepack; other tools remain detection-only until platform-specific packs are added.

## Architecture

Coding agents are clients of the runtime.

Kilo Code, Codex, Claude Code, Cline, local LLMs, or other clients should eventually access the same capabilities through CLI and MCP interfaces.

Core workflow logic remains independent from tool installation. The separate `@llmatic/tool-registry` package depends on core permission configuration and exposes deterministic detection/installation operations to clients.

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

Useful CLI commands:

    llmatic detect
    llmatic doctor
    llmatic status
    llmatic validate
    llmatic tools list
    llmatic tools install pnpm --approve

## Roadmap

Next milestones add:

1. Git adapter
2. repository intelligence and AST indexing
3. GitHub adapter
4. MCP server
5. task-provider adapters such as Jira
6. Docker, Supabase, Python, and local-LLM tool packs
7. automated code-review and remote-CI orchestration
8. controlled PR/merge/deploy actions

See docs/architecture.md, docs/security-model.md, docs/workflow-state.md, docs/orchestration.md, and docs/tools.md.
