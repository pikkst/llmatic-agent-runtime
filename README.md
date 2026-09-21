# LLMatic Agent Runtime

Universal local software-engineering runtime for coding agents.

LLMatic Agent Runtime gives coding agents deterministic, repository-aware engineering capabilities while keeping workflow state, permissions, validation, repository intelligence, Git, GitHub, task providers, and local tool execution outside the model prompt.

## Current milestone

M10 — Runtime Tool Packs

Implemented:

- persistent workflow state and audit checkpoints
- repository/capability detection and local CI
- protected Git and GitHub adapters
- repository AST/import intelligence
- MCP v2 stdio server
- provider-neutral task layer and Jira adapter
- Docker local lifecycle pack
- Supabase local-development pack
- Python/uv execution pack
- Ollama local-model pack
- whitelist-only runtime execution with permission gates

## Runtime tools

Inspect:

    llmatic runtime inspect

Examples:

    llmatic runtime run docker status
    llmatic runtime run docker up --approve

    llmatic runtime run supabase status
    llmatic runtime run supabase db-reset-local --approve

    llmatic runtime run python run-script --script scripts/check.py --approve

    llmatic runtime run ollama list
    llmatic runtime run ollama run --model qwen3:8b --prompt "Review this change" --approve

See `docs/runtime-tool-packs.md` for the safety boundary.

## Safety model

There is no arbitrary shell execution API.

Runtime packs construct fixed executable/argument arrays from whitelisted operations. Dangerous remote database/deployment operations are not part of M10.

MCP never self-approves an `ask` permission.

## Development

    corepack enable
    pnpm install
    pnpm ci:local
    pnpm build

## Roadmap

Next milestones add:

1. automated code-review orchestration
2. richer installer/bootstrap plans for runtime dependencies
3. richer Jira field/status policies
4. controlled deployment/release adapters
5. optional Streamable HTTP MCP serving

See the documents under `docs/`.
