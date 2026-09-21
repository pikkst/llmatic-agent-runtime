# Verified self-update

M18 adds an explicit self-update path on top of the M17 release manifest.

Before installation, LLMatic verifies repository identity, release tag identity, VSIX asset name, byte size and SHA-256.

Verified bytes are staged under VS Code global storage:

    <globalStorage>/updates/<version>/<sha-prefix>/<file>.vsix

Commands:

    LLMatic: Check for Updates
    LLMatic: Install Latest Update

Installation always requires explicit user confirmation. There is no silent background installation.

M18 also adds an extension-surface regression test so CI fails if the VS Code activate/deactivate entrypoint or critical command registrations disappear.
