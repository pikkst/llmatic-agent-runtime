# M19 release acceptance

M19 turns the release pipeline into an executable acceptance contract.

## Automated acceptance

Command:

    pnpm release:acceptance v0.1.0 <commit-sha>

Prerequisites:

    corepack enable
    pnpm install
    pnpm exec tsc -b packages/release-metadata packages/update-installer
    pnpm run ci

The acceptance command verifies:

- tag/root-package/extension versions match
- release manifest is generated and schema-valid
- VSIX byte size and SHA-256 match the manifest
- VSIX can be extracted
- packaged extension version is correct
- packaged main entry is dist/extension.cjs
- packaged activation bundle is non-trivial
- critical Get Ready / review / update / repair command signals exist in the bundle
- packaged runtime manifest matches release manifest
- packaged runtime bytes match SHA-256 and size
- package does not contain .llmatic or node_modules runtime footprint

## GitHub acceptance workflow

A manual Release Acceptance workflow can validate any commit before a real tag is pushed.

Input:

    v0.1.0

It runs canonical CI, acceptance, then uploads the accepted VSIX and release manifest as workflow artifacts.

## Real v0.1.0 release

After M19 is merged and main is green, from a local checkout of main:

    git pull --ff-only origin main
    git tag -a v0.1.0 -m "LLMatic Agent Runtime v0.1.0"
    git push origin v0.1.0

The tag starts the Release workflow.

The workflow now refuses to publish until the same release acceptance passes against the tagged commit.

## Manual clean-install acceptance

After the GitHub Release exists:

1. open a clean VS Code profile
2. install the v0.1.0 VSIX from the GitHub Release
3. open a disposable local repository
4. confirm the LLMatic Activity Bar loads
5. run LLMatic: Get Ready
6. confirm runtime state becomes READY or gives specific missing-tool setup
7. if Kilo Code is installed, confirm global LLMatic MCP registration is created/reconciled
8. run LLMatic: Doctor and require no FAIL results
9. run LLMatic: Check for Updates and confirm v0.1.0 reports up to date
10. confirm no .llmatic/toolbox/runtime files were added to the repository

## Upgrade acceptance

The verified upgrade path needs two different versions. For v0.1.0, the self-update code path is release-ready but a real newer-version upgrade cannot be truthfully completed until v0.1.1 or later exists.

When the next version is published:

1. install v0.1.0
2. Check for Updates
3. require the new release to be detected
4. choose Install Update
5. require repository/tag/manifest/asset identity checks
6. require VSIX size + SHA-256 verification
7. approve installation
8. reload VS Code
9. verify the new version and runtime health
