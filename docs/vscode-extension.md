# VS Code extension

M11 introduces the first installable editor integration for LLMatic.

## Zero-repo workspace model

The extension does not require `.llmatic/` or `llmatic.agent.yaml` in the repository.

For each repository it creates a deterministic workspace directory under VS Code extension global storage:

    <extension-global-storage>/workspaces/<workspace-id>/
      llmatic.agent.yaml
      state/
      cache/

The workspace ID is derived from the normalized absolute repository path.

The runtime discovers this managed configuration through the `LLMATIC_HOME` environment variable.

A repository-level `llmatic.agent.yaml` still takes precedence when a team deliberately wants to version shared policy.

## Local Git exclude

The extension adds fallback local-only patterns to:

    .git/info/exclude

Patterns:

    .llmatic/
    llmatic.agent.local.yaml
    llmatic.agent.local.yml

The tracked project `.gitignore` is not modified.

Git worktrees with a `.git` pointer file are supported.

## Kilo Code integration

Kilo Code is detected through the extension ID:

    kilocode.kilo-code

When auto-connect is enabled, LLMatic updates the global Kilo config:

    ~/.config/kilo/kilo.jsonc

with a local MCP server named `llmatic`.

The JSONC update preserves user comments and unrelated MCP servers.

The registered environment contains:

    LLMATIC_HOME=<VS Code extension global storage>

No repository path is hard-coded into the global Kilo config.

## Bundled MCP runtime

The extension build bundles:

- the VS Code extension host entry
- a standalone LLMatic MCP stdio server

The Kilo MCP registration launches the bundled server through the configured Node executable.

Default:

    node <extension>/dist/runtime/mcp-server.mjs

## Kilo Gateway API key

The command:

    LLMatic: Set Kilo Gateway API Key

stores the value only through VS Code `SecretStorage`.

The key is not written to:

- repository files
- `.env`
- `llmatic.agent.yaml`
- Kilo JSONC config
- workflow state

M11 only provides secure storage. Direct Gateway model orchestration is a later milestone.

## Commands

- LLMatic: Attach Workspace
- LLMatic: Connect Kilo Code Globally
- LLMatic: Show Status
- LLMatic: Set Kilo Gateway API Key
- LLMatic: Clear Kilo Gateway API Key
- LLMatic: Reveal Workspace Runtime Data

## Settings

- `llmatic.autoAttachWorkspace`
- `llmatic.autoConnectKilo`
- `llmatic.nodeCommand`
- `llmatic.runtimeMcpPath`

## Build

The root production build also bundles the extension:

    pnpm build

The generated editor bundle is ignored by Git and will later be packaged into VSIX/Marketplace artifacts.
