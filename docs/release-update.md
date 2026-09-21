# Release and update pipeline

M17 adds a reproducible GitHub release contract for the VS Code extension.

## Release trigger

A release is created only from a semantic Git tag:

    vX.Y.Z

The tag version must exactly match:

- root package.json
- apps/vscode-extension/package.json

A mismatch fails before publishing.

## Release gates

The release workflow:

1. checks out the tagged commit
2. installs dependencies
3. verifies version coherence
4. runs the canonical local CI
5. packages the VSIX
6. computes the VSIX SHA-256
7. reads the bundled runtime SHA-256 manifest
8. writes release-manifest.json
9. publishes the VSIX + manifest in a GitHub Release

The release manifest records the exact commit, VSIX hash/size and bundled runtime hash/size.

## Extension update check

Command:

    LLMatic: Check for Updates

The extension fetches the repository's latest GitHub Release, downloads release-manifest.json, validates its schema/tag/hash fields and compares semantic versions.

It does not install unverified bytes or silently replace the running extension. M17 only surfaces a verified newer release and opens its GitHub Release page.

Self-install/update can be added later on top of the same manifest contract.
