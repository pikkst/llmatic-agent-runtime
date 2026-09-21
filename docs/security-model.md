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

## Design rule

A coding agent must not silently bypass the runtime permission model by falling back to raw shell commands for an operation that has a registered protected capability.

Enforcement becomes stronger as orchestration and MCP layers are added.
