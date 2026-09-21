# VS Code Marketplace Publishing

LLMatic publishes GitHub release artifacts through the existing tag-driven release workflow. Marketplace publication is an additional gated step using Visual Studio Marketplace trusted publishing with GitHub Actions OIDC.

No Marketplace PAT is stored in the repository.

## Extension identity

```text
Publisher: eventnexus
Extension name: llmatic-agent-runtime
Extension ID: eventnexus.llmatic-agent-runtime
Marketplace workflow: .github/workflows/release.yml
```

The publisher ID is part of the public extension identity. Confirm that the `eventnexus` publisher is owned by the intended organization before the first Marketplace publication.

## One-time Marketplace setup

1. Sign in to the Visual Studio Marketplace publisher management portal.
2. Create or select the publisher with ID `eventnexus`.
3. Configure trusted publishing for this GitHub repository:
   - GitHub owner: `pikkst`
   - repository: `llmatic-agent-runtime`
   - workflow: `.github/workflows/release.yml`
4. Configure any Marketplace policy fields required by the trusted-publishing form.
5. In the GitHub repository, create the Actions variable:
   ```text
   VSCODE_MARKETPLACE_PUBLISH=true
   ```

Until that variable is exactly `true`, tag releases still publish the GitHub Release but skip Marketplace publication.

## Release flow

For a release such as `v0.1.1`:

```text
tag push
  -> build release contract
  -> verify root + extension versions match tag
  -> full CI
  -> package VSIX
  -> release acceptance
  -> real VS Code clean-install acceptance
  -> verify release files
  -> upload accepted candidate
  -> Marketplace publish with vsce --oidc (when enabled)
  -> GitHub Release
```

Marketplace publishing always uses the exact accepted versioned VSIX from the release pipeline.

## Enabling publication

After trusted publishing has been configured in Visual Studio Marketplace, set:

```text
Repository Settings
  -> Secrets and variables
  -> Actions
  -> Variables
  -> VSCODE_MARKETPLACE_PUBLISH = true
```

Then create and push the semantic version tag only after the tagged commit has passed CI.

## Disabling publication

Set `VSCODE_MARKETPLACE_PUBLISH` to `false` or delete the variable.

This does not affect GitHub Release publication.

## Local packaging

Package a VSIX without publishing:

```bash
pnpm install
pnpm run ci
pnpm run package:vsix
```

The generated candidate is written under `artifacts/`.

## Manual Marketplace fallback

If trusted publishing is unavailable, the already accepted VSIX may be uploaded manually from the Visual Studio Marketplace publisher management page.

Do not introduce a long-lived PAT into the repository or workflow as a workaround.

## Version contract

The release tag, root `package.json` version, and `apps/vscode-extension/package.json` version must match.

Example:

```text
tag: v0.1.1
root package: 0.1.1
extension package: 0.1.1
```

The release workflow rejects mismatches before publication.
