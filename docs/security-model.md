# Security model

The runtime separates local deterministic operations from externally mutating operations.

## Permission levels

Each sensitive capability is configured as one of:

- auto: the runtime may execute without interactive approval
- ask: explicit approval is required
- deny: execution is prohibited

The initial configuration distinguishes:

- repository read/write
- local quality-gate execution
- test execution
- Docker
- tool installation
- Git push
- pull-request creation
- pull-request merge
- database migration
- production deployment

Production deployment is denied by default.

## Capability execution

Repository quality gates are executed through detected structured process definitions:

    executable + args

The runtime does not execute the display-only command string.

Quality gates are controlled by runQualityGates. Tests use runTests as a narrower permission.

A permission configured as ask requires an explicit --approve flag at the CLI boundary.

## Tool installation

Tool installation is controlled by the `installTools` permission.

The tool registry stores installers as structured command steps:

    executable + args

The runtime never treats registry installer metadata as an arbitrary shell script. Tools without a registered automated installer are detection-only and must be installed manually or by a future platform-specific pack.

The first automated installer is pnpm through Corepack. It is still permission-gated and is not executed implicitly by tool detection.

## Design rule

A coding agent must not silently bypass the runtime permission model by falling back to raw shell commands for an operation that has a registered protected capability.

Enforcement becomes stronger as orchestration and MCP layers are added.

## GitHub pull requests

GitHub mutations use the local GitHub CLI through structured arguments with shell execution disabled.

Pull-request creation is controlled by `createPullRequest`.

Pull-request merge is controlled by `mergePullRequest`.

Workflow merge resolves the current pull request head SHA immediately before merge and passes it through `gh pr merge --match-head-commit`. This prevents a stale approval or review state from silently merging a newer head commit.
