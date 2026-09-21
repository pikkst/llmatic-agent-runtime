# Architecture

LLMatic Agent Runtime is an agent-neutral local software-engineering runtime.

The runtime exposes deterministic capabilities to coding agents instead of requiring each model to know project-specific shell commands.

## Core principle

Agents request capabilities such as:

- format
- lint
- typecheck
- test
- build
- CI

The runtime resolves those capabilities to repository-specific commands.

For example, the logical capability test may resolve to a package script in a TypeScript repository and later to pytest, cargo test, or dotnet test through additional adapters.

## Initial components

### CLI

The first client surface is the llmatic CLI.

Initial commands:

- llmatic init
- llmatic detect
- llmatic doctor

### Core

The core package owns:

- repository detection
- capability discovery
- runtime configuration
- environment diagnostics

### Future components

Planned layers include:

- persistent workflow state machine
- tool registry and installers
- repository intelligence and AST indexing
- Git/GitHub adapters
- task-provider adapters such as Jira
- MCP server
- Docker and Supabase packs
- review and CI orchestration

## Dependency direction

Coding agents are clients of the runtime.

Kilo Code, Codex, Claude Code, Cline, local models, or other clients should communicate through CLI/MCP capabilities. Agent-specific behavior must not leak into the core runtime.
