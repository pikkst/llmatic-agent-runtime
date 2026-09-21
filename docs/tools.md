# Tool registry

M4 adds an agent-neutral registry for local engineering tools.

## Why a registry

Coding agents should not invent installation commands or probe the machine with arbitrary shell snippets.

A registered tool has:

- a stable tool id
- a display name
- one or more structured probes
- baseline/optional classification
- an optional controlled installer
- structured installer steps

Every executable action is represented as:

    executable + args

## List tools

    llmatic tools list

Machine-readable output:

    llmatic tools list --json

The initial registry knows about:

- Node.js
- Git
- pnpm
- Docker
- GitHub CLI
- Deno
- Supabase CLI
- Python
- uv
- Ollama

Detection does not mutate the machine.

## Install a tool

The initial automated installer is pnpm through Corepack:

    llmatic tools install pnpm --approve

The default configuration uses:

    installTools: ask

Therefore the installer cannot execute without explicit approval.

If `installTools` is `deny`, installation is rejected even when `--approve` is supplied.

## Unsupported automated installers

Tools such as Docker, GitHub CLI, Deno, Supabase CLI, Python, uv, and Ollama are detection-only in this milestone.

The runtime intentionally does not guess operating-system package-manager commands. Future platform-specific packs can register installers without changing the core runtime.

## Safety boundary

An agent may use registry detection automatically.

An agent must use the registry installer path for registered tool installation. Falling back to an arbitrary shell installer would bypass the runtime permission model and is not a valid orchestration path.
