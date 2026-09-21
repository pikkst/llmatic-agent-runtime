# Runtime lifecycle and repair

M15 separates the extension package from the executable MCP runtime lifecycle.

## Build manifest

The extension build writes:

    dist/runtime/mcp-server.mjs
    dist/runtime/manifest.json

The manifest contains:

- schema version
- extension/runtime version
- runtime file name
- SHA-256
- byte size

## Install location

On activation the extension verifies the bundled runtime and installs it under VS Code global storage:

    <globalStorage>/runtime/<version>/<sha-prefix>/mcp-server.mjs

Kilo MCP is registered against this stable installed path.

This prevents Kilo from depending on a path inside the currently installed VS Code extension version.

## Integrity

Before install:

1. bundled size must match the manifest
2. bundled SHA-256 must match the manifest

After install the runtime is hashed again.

Doctor reports runtime integrity as PASS or FAIL.

## Repair

Command:

    LLMatic: Repair Runtime

Repair:

1. re-verifies the bundled runtime
2. rewrites the versioned installed runtime
3. verifies the installed SHA-256
4. reconciles Kilo global MCP registration
5. offers a VS Code reload when the Kilo registration changed

A configured `llmatic.runtimeMcpPath` is treated as an explicit developer override and is not overwritten by Repair Runtime.

## Repository boundary

Runtime installation is entirely outside the opened repository.

No package, runtime, state, cache, config, or repair artifact is added to tracked repository files.
