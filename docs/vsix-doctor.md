# VSIX packaging and Doctor

M12 turns the editor integration into a locally installable VS Code extension artifact.

## Build and package

Requirements for VSIX packaging:

- Node.js 22+
- pnpm

Run:

    pnpm build
    pnpm package:vsix

Output:

    artifacts/llmatic-agent-runtime.vsix

The canonical local/hosted CI pipeline packages the VSIX after the production bundle, so a green CI run proves that the extension manifest and packaged file set are valid.

The extension uses a bundled runtime, so VSIX packaging runs `vsce package --no-dependencies`; workspace dependencies are already included in the generated extension/MCP bundles.

## Install locally

VS Code command line:

    code --install-extension artifacts/llmatic-agent-runtime.vsix

Or use:

Extensions -> ... -> Install from VSIX...

## Doctor

Run:

    LLMatic: Doctor

Checks:

- active workspace attachment
- managed config availability
- bundled MCP runtime
- configured Node executable and minimum runtime version
- Kilo Code extension installation
- Kilo global MCP registration health
- optional Kilo Gateway API key presence

Detailed output is written to the `LLMatic` Output channel.

## Kilo config refresh

When a manual `LLMatic: Connect Kilo Code Globally` command changes the global Kilo MCP registration, the extension offers a VS Code window reload.

Automatic startup reconciliation remains silent; status and Doctor expose whether the registration is healthy.

## Marketplace readiness

The extension manifest now uses the Marketplace-safe name:

    llmatic-agent-runtime

and includes publisher, license, repository, README, changelog, runtime bundle, and a package exclusion list.

Actual Marketplace publishing remains a separate release step because the publisher identity must exist in Visual Studio Marketplace.
