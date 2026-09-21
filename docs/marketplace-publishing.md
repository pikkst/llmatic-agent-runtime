# VS Code Marketplace Publishing

LLMatic publishes GitHub release artifacts through the tag-driven release workflow. Marketplace publication is a separate gated job that uses Microsoft Entra ID authentication through GitHub Actions OIDC and `vsce publish --azure-credential`.

No Visual Studio Marketplace PAT or Entra client secret is stored in the repository.

## Extension identity

```text
Publisher: eventnexus
Extension name: llmatic-agent-runtime
Extension ID: eventnexus.llmatic-agent-runtime
Release workflow: .github/workflows/release.yml
Identity setup workflow: .github/workflows/marketplace-identity.yml
GitHub environment: marketplace-production
```

The first public Marketplace release, v0.1.1, was uploaded manually from the accepted GitHub Release VSIX. Future releases can use Entra ID automation after the one-time identity setup below is complete.

## Authentication model

The Marketplace publish job uses this chain:

```text
GitHub Actions
  -> GitHub OIDC token
  -> Microsoft Entra federated credential
  -> azure/login
  -> Azure CLI credential
  -> vsce --azure-credential
  -> Visual Studio Marketplace publisher eventnexus
```

The release-build job does not receive an Entra OIDC token. Marketplace publishing runs in its own job with only:

```text
contents: read
id-token: write
```

## One-time Microsoft Entra setup

### 1. Create an Entra app registration

In Microsoft Entra admin center:

1. Open **App registrations**.
2. Create a new registration, for example:
   ```text
   LLMatic Marketplace Publisher
   ```
3. Record:
   - **Application (client) ID**
   - **Directory (tenant) ID**

A client secret is not required.

### 2. Create the GitHub environment

In GitHub:

```text
pikkst/llmatic-agent-runtime
  -> Settings
  -> Environments
  -> New environment
  -> marketplace-production
```

Optional but recommended: add required reviewers to this environment so a Marketplace publish requires explicit approval.

### 3. Add an Entra federated credential

On the Entra app registration:

```text
Certificates & secrets
  -> Federated credentials
  -> Add credential
  -> GitHub Actions deploying Azure resources
```

Use:

```text
GitHub organization/owner: pikkst
Repository: llmatic-agent-runtime
Entity type: Environment
Environment: marketplace-production
Audience: api://AzureADTokenExchange
```

This produces the GitHub OIDC subject:

```text
repo:pikkst/llmatic-agent-runtime:environment:marketplace-production
```

### 4. Add GitHub environment secrets

Add these secrets to the `marketplace-production` GitHub environment:

```text
VSCODE_MARKETPLACE_AZURE_CLIENT_ID=<Application client ID>
VSCODE_MARKETPLACE_AZURE_TENANT_ID=<Directory tenant ID>
```

No Azure subscription ID is required by this workflow because `azure/login` is configured with `allow-no-subscriptions: true`.

### 5. Resolve the Marketplace identity resource ID

Run this GitHub Actions workflow manually:

```text
Actions
  -> Marketplace Entra Identity
  -> Run workflow
```

The workflow authenticates with the federated Entra identity and calls the Azure DevOps profile endpoint for resource:

```text
499b84ac-1321-427f-aa17-267ca6975798
```

The run summary prints:

```text
Marketplace identity resource ID: <GUID>
```

### 6. Authorize the identity in Visual Studio Marketplace

Open the publisher management page for `eventnexus`, then:

```text
Members
  -> Add
  -> <Marketplace identity resource ID>
  -> Contributor
```

The exact Marketplace UI wording may vary, but the Entra identity must be a member of publisher `eventnexus` with Contributor publishing rights.

### 7. Verify authorization

Do not enable automatic publishing yet.

After the Marketplace member is added, the next release publish job performs this preflight before publishing:

```text
vsce verify-pat eventnexus --azure-credential
```

Despite the historical command name `verify-pat`, current `vsce` supports Entra authentication for this verification when `--azure-credential` is supplied.

### 8. Enable Marketplace publication

Only after the Entra identity is authorized, create or set this GitHub Actions repository variable:

```text
VSCODE_MARKETPLACE_PUBLISH=true
```

Until the value is exactly `true`, semantic-version tag releases still build, validate, run clean-install acceptance, publish the accepted GitHub Release, and skip Marketplace automation.

## Release flow

For a future release such as `v0.1.2`:

```text
tag push
  -> release job
       -> verify root + extension versions match tag
       -> full CI
       -> package VSIX
       -> release acceptance
       -> real VS Code clean-install acceptance
       -> verify release files
       -> upload accepted candidate artifact
       -> publish GitHub Release
  -> marketplace_publish job (only when enabled)
       -> download exact accepted candidate
       -> GitHub OIDC -> Entra login
       -> verify publisher authorization
       -> vsce publish --azure-credential
```

Marketplace publishing always consumes the exact accepted versioned VSIX produced by the release job.

## Disabling publication

Set `VSCODE_MARKETPLACE_PUBLISH` to `false` or delete the variable.

This does not affect GitHub Release publication.

## Manual Marketplace fallback

If Entra automation is not configured or is temporarily unavailable:

1. Keep `VSCODE_MARKETPLACE_PUBLISH` disabled.
2. Let the release workflow complete successfully.
3. Download the versioned accepted VSIX from the GitHub Release.
4. Upload that exact VSIX through the Visual Studio Marketplace publisher management page.

Do not add a long-lived Marketplace PAT or Entra client secret to the repository as a workaround.

## Local packaging

Package a VSIX without publishing:

```bash
pnpm install
pnpm run ci
pnpm run package:vsix
```

The generated candidate is written under `artifacts/`.

## Version contract

The release tag, root `package.json` version, and `apps/vscode-extension/package.json` version must match.

Example:

```text
tag: v0.1.2
root package: 0.1.2
extension package: 0.1.2
```

The release workflow rejects mismatches before publication.
