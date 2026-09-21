# VS Code extension

M11 introduces the desktop VS Code integration for LLMatic Agent Runtime.

## Goal

Install once, open a local Git repository, and attach the LLMatic runtime without adding runtime state/config/cache files to the repository.

VS Code desktop is the first target because LLMatic needs local process execution for Git, CI, Docker, Supabase, Python, Ollama, and the stdio MCP server. VS Code web extensions cannot launch local child processes.

## Zero-repo-footprint workspace storage

The extension uses `ExtensionContext.globalStorageUri`.

For each repository root it derives a stable SHA-256 workspace id and creates:

    <VS Code globalStorage>/workspaces/<workspace-id>/
      llmatic.agent.yaml
      state/
      cache/

The generated `llmatic.agent.yaml` points its state/cache directories to those private locations.

No tracked repository file is required.

Core config resolution supports:

1. `LLMATIC_CONFIG_PATH`
2. `LLMATIC_WORKSPACE_HOME/workspaces/<workspace-id>/llmatic.agent.yaml`
3. legacy repo-local `llmatic.agent.yaml`

The old CLI workflow remains compatible.

## Local Git ignore

As defense in depth, the extension can add these patterns to the repository-local Git exclude file:

    .llmatic/
    llmatic.agent.local.yaml

It resolves the exclude path through:

    git rev-parse --git-path info/exclude

This works without modifying the repository's tracked `.gitignore`.

## Bundled MCP runtime

The VS Code extension build creates:

    dist/extension.cjs
    dist/runtime/llmatic-mcp.mjs

The second file is a bundled standalone LLMatic MCP stdio server.

A custom runtime path can be configured with:

    llmatic.runtime.mcpServerPath

## Kilo Code global connector

Command:

    LLMatic: Connect Kilo Code Globally

The extension edits the user-level Kilo config:

    ~/.config/kilo/kilo.jsonc

Windows uses the same path under the user's home directory.

The JSONC update preserves comments and unrelated settings. It adds:

    {
      "mcp": {
        "llmatic": {
          "type": "local",
          "command": ["node", "<bundled-llmatic-mcp.mjs>"],
          "environment": {
            "LLMATIC_WORKSPACE_HOME": "<VS Code global storage>"
          },
          "enabled": true,
          "timeout": 30000
        }
      }
    }

The extension offers this connection once and requires the user to choose Connect before modifying Kilo's global configuration.

## Secrets

Command:

    LLMatic: Store Kilo Gateway API Key

The value is stored through VS Code `SecretStorage`.

It is not written to:

- the repository
- `.env`
- `llmatic.agent.yaml`
- Kilo config
- workflow checkpoints

M11 only establishes secure storage. Direct Kilo Gateway orchestration is a later milestone.

## UI

The extension contributes:

- LLMatic Activity Bar view
- workspace/runtime/Kilo/key status
- `LLMatic: READY` status bar state
- initialize/connect/key/config commands

## Build

    pnpm build:extension

or the normal repository build:

    pnpm build

The normal build compiles all TypeScript projects and then bundles the extension and embedded MCP runtime.
