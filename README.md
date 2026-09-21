# LLMatic Agent Runtime

Universal local software-engineering runtime for coding agents.

LLMatic now supports a zero-repo-footprint VS Code integration: install the extension once, open a Git repository, and keep workflow state, cache, runtime configuration, and secrets outside the repository.

## Current milestone

M11 — VS Code Extension Core

Implemented:

- persistent workflow/runtime engine
- protected Git/GitHub/Jira/runtime-tool adapters
- repository AST intelligence
- MCP v2 stdio server
- VS Code desktop extension
- private per-workspace storage in VS Code global storage
- zero tracked LLMatic files required in managed repositories
- local `.git/info/exclude` fallback protection
- extension-bundled MCP runtime
- global Kilo MCP registration
- VS Code SecretStorage foundation for Kilo Gateway credentials
- Activity Bar + status bar integration

## Zero-repo workflow

Open any Git repository in VS Code.

The extension creates private state outside the repo:

    <VS Code globalStorage>/workspaces/<workspace-hash>/
      llmatic.agent.yaml
      state/
      cache/

Kilo can use one global MCP registration for all repositories:

    ~/.config/kilo/kilo.jsonc

No project-level Kilo or LLMatic tool files are required.

## Development

    corepack enable
    pnpm install
    pnpm ci:local
    pnpm build

Build only the extension bundles:

    pnpm build:extension

See `docs/vscode-extension.md`.

## Roadmap

Next milestones:

1. extension runtime installer/updater and version pinning
2. richer extension onboarding/health UI
3. Kilo Gateway-backed autonomous orchestrator
4. automated code-review/fix loop
5. extension packaging/VSIX + Marketplace release pipeline
6. controlled deployment/release adapters
