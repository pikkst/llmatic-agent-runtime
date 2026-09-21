# LLMatic Agent Runtime

Universal local software-engineering runtime for coding agents.

## Current milestone

M11 — VS Code Extension + Zero-Repo Workspace

The runtime can now be integrated at editor/user level instead of being installed into every repository.

### VS Code integration

- auto-attaches opened repositories
- stores config/state/cache outside the repository
- uses deterministic workspace identities
- keeps local fallback artifacts in `.git/info/exclude`, not tracked `.gitignore`
- detects Kilo Code
- registers LLMatic as a global Kilo MCP server
- preserves existing Kilo JSONC comments/settings
- bundles the MCP runtime with the extension
- stores a Kilo Gateway API key only in VS Code SecretStorage
- exposes a READY/status-bar indicator

### Runtime configuration lookup

Config precedence:

1. `LLMATIC_CONFIG_PATH`
2. repository `llmatic.agent.yaml` (optional shared team policy)
3. `LLMATIC_HOME/workspaces/<workspace-id>/llmatic.agent.yaml`

This means repositories can remain completely free of LLMatic runtime files.

### Existing runtime

The extension sits on top of the existing CLI/MCP runtime:

- Jira task provider
- repository intelligence
- local CI
- Git/GitHub workflow
- Docker/Supabase/Python/Ollama tool packs
- persistent workflow/checkpoints
- protected permission model

## Development

    corepack enable
    pnpm install
    pnpm ci:local
    pnpm build

The build produces:

    apps/vscode-extension/dist/extension.cjs
    apps/vscode-extension/dist/runtime/mcp-server.mjs

## Workspace bootstrap

The VS Code command `LLMatic: Bootstrap Workspace` now derives tool requirements from the opened repository and offers controlled remediation for registry-backed installers.

It does not add LLMatic packages or tool descriptions to the repository.

See `docs/bootstrap-remediation.md`.

## Next milestones

1. runtime bootstrap/installer UX and VSIX packaging
2. richer Kilo connector health/reload flow
3. agent orchestrator using securely stored Gateway credentials
4. automated review/fix loop
5. Marketplace publishing and update channel

See `docs/vscode-extension.md` and the runtime documents under `docs/`.
