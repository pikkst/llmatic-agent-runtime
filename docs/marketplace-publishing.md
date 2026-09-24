# VS Code Marketplace Publishing

LLMatic uses a split release model:

```text
semantic-version tag
  -> deterministic GitHub Actions release pipeline
  -> accepted versioned VSIX + release manifest
  -> GitHub Release
  -> manual Visual Studio Marketplace upload of that exact accepted VSIX
```

Marketplace publication is intentionally manual in v0.3.1. The repository does not depend on a Marketplace PAT, Microsoft Entra application, GitHub OIDC Marketplace policy, or hidden publisher credentials.

## Extension identity

```text
Publisher: eventnexus
Extension name: llmatic-agent-runtime
Extension ID: eventnexus.llmatic-agent-runtime
Release workflow: .github/workflows/release.yml
```

## Canonical release flow

For a release such as `v0.3.1`:

```text
update root + extension versions
  -> merge green release PR
  -> tag v0.3.1
  -> push tag
  -> release workflow
       -> frozen-lockfile dependency install
       -> verify tag/version contract
       -> full CI
       -> package VSIX
       -> release acceptance
       -> VS Code clean-install acceptance
       -> verify hashes/files
       -> upload accepted Actions artifact
       -> publish GitHub Release
       -> print Marketplace handoff summary
  -> publisher manually uploads the exact GitHub Release VSIX
```

The Marketplace upload must use the exact versioned VSIX attached to the GitHub Release:

```text
llmatic-agent-runtime-<version>.vsix
```

Do not rebuild the extension locally for Marketplace publication after the GitHub Release succeeds. Rebuilding would produce a different artifact than the release candidate that passed acceptance.

## Manual Marketplace publication

1. Open the matching GitHub Release.
2. Download:
   ```text
   llmatic-agent-runtime-<version>.vsix
   ```
3. Open the Visual Studio Marketplace publisher management page for `eventnexus`.
4. Select **LLMatic Agent Runtime**.
5. Upload/update the extension with the downloaded VSIX.
6. Confirm that the Marketplace shows the expected version and public availability.

The release manifest remains attached to the GitHub Release for integrity/provenance verification.

## Why Marketplace publishing is manual

The Marketplace publisher UI currently used by this project does not expose a trusted-publishing policy that can be bound to the repository workflow. The earlier Entra/OIDC automation scaffolding was therefore removed instead of keeping a release path that could not be exercised end to end.

Automation may be reintroduced later only when the Marketplace supports a documented, testable authentication path for this publisher.

## GitHub Actions permissions

The workflow-level default is read-only:

```yaml
permissions:
  contents: read
```

Only the release job receives:

```yaml
permissions:
  contents: write
```

That write permission is used to create the GitHub Release.

## Deterministic dependency install

Tagged releases install dependencies with:

```bash
pnpm install --frozen-lockfile
```

A release fails instead of silently mutating dependency resolution when the lockfile and package manifests disagree.

## Release concurrency

The release workflow serializes work per tag:

```yaml
concurrency:
  group: release-${{ github.ref }}
  cancel-in-progress: false
```

A second invocation for the same tag cannot cancel an in-flight accepted release.

## Version contract

These values must match exactly:

```text
tag: v0.3.1
root package.json: 0.3.1
apps/vscode-extension/package.json: 0.3.1
```

The release workflow verifies the contract before publication.

## Local verification

Before merging a release PR:

```bash
pnpm install
pnpm run ci:local
```

For release-specific validation:

```bash
pnpm run package:vsix
node scripts/release-acceptance.mjs v0.3.1 <commit-sha>
```

The tag-driven workflow repeats the full validation and clean-install acceptance on the tagged commit.

## Credentials and repository settings

v0.3.1 does **not** use:

```text
VSCODE_MARKETPLACE_PUBLISH
VSCODE_MARKETPLACE_AZURE_CLIENT_ID
VSCODE_MARKETPLACE_AZURE_TENANT_ID
marketplace-production environment
Marketplace PAT
```

Any leftover GitHub variable/environment secret from the experimental automation can be deleted after this cleanup is merged.
