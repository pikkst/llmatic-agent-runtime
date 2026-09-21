# LLMatic Agent Runtime

Universal local software-engineering runtime for coding agents.

## Current milestone

M13 — Gateway Agent Orchestrator

LLMatic can now operate in two complementary modes:

1. **Kilo-driven** — Kilo Code calls the global LLMatic MCP server.
2. **LLMatic-driven** — the VS Code extension runs a constrained coding agent through Kilo Gateway.

The direct agent defaults to:

    kilo-auto/free

The model can be changed with the `llmatic.agentModel` setting.

## Direct agent safety boundary

The direct Gateway agent can:

- search the repository index
- read bounded repository text files
- replace one exact text occurrence
- create new repository text files
- run detected format/lint/typecheck/test/build capabilities
- run the existing local workflow validation
- inspect Git/workflow status

It cannot:

- read common secret files such as `.env`, private keys, or credentials
- escape the repository through paths or symlinks
- execute arbitrary shell commands
- install packages
- push Git branches
- create or merge pull requests
- mutate databases
- deploy

Operations configured as `ask` cannot be self-approved by the direct agent.

## Auto Free privacy

`kilo-auto/free` requires no Kilo credits, but Kilo documents that Auto Free may route requests to providers that log prompts and outputs. The extension shows a one-time warning before direct Auto Free usage.

Do not use Auto Free for confidential source repositories. Choose a provider/model whose data policy matches the repository when confidentiality is required.

## Existing editor/runtime integration

- zero-repo VS Code workspace state
- `.git/info/exclude` fallback protection
- bundled MCP runtime
- global Kilo MCP registration
- VS Code SecretStorage for Gateway credentials
- VSIX packaging and Doctor checks
- Jira, GitHub, local CI, Docker, Supabase, Python, and Ollama runtime adapters

## Development

    corepack enable
    pnpm install
    pnpm ci:local
    pnpm build
    pnpm package:vsix

See `docs/vscode-extension.md`, `docs/vsix-doctor.md`, and `docs/gateway-agent.md`.
