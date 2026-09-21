# Changelog

## 0.1.0

- Initial VS Code extension.
- Zero-repository workspace storage.
- Global Kilo MCP registration.
- Bundled LLMatic MCP runtime.
- VS Code SecretStorage integration.
- LLMatic Doctor health checks.

## M13 — Gateway agent orchestrator

- Added a direct Kilo Gateway coding-agent command.
- Default model is `kilo-auto/free`.
- Added an Auto Free data-handling warning before first use.
- Added repository-contained safe file tools and quality-gate tool loops.
- Gateway credentials remain in VS Code SecretStorage.
- Direct agent has no push, PR, merge, deployment, package-install, database, or arbitrary shell tools.

## M14 — Review / fix loop

- Added structured Kilo Gateway code review with blocking and non-blocking findings.
- Added workflow-aware CODE_REVIEW to FIXING or READY_TO_PUSH transitions.
- Added automated blocking-finding fix, local validation, and re-review loop.
- Review uses changed-files-first context and bounded repository read/diff tools.
- Added VS Code commands for one-shot review and automated review/fix loop.

## Carried forward — Workspace bootstrap

- Restored the repository-aware Bootstrap Workspace command from the original PR #13 branch.
- Bootstrap derives required/recommended/optional tools from repository signals.
- Automatic remediation remains restricted to Tool Registry installers and explicit user approval.
- Bootstrap preserves the zero-repository-footprint boundary.
