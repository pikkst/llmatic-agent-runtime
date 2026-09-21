# Security model

The runtime separates local deterministic operations from externally mutating operations.

## Permission levels

Each sensitive capability is configured as one of:

- auto: the runtime may execute without interactive approval
- ask: explicit approval is required
- deny: execution is prohibited

The initial configuration distinguishes:

- repository read/write
- test execution
- Docker
- tool installation
- Git push
- pull-request creation
- pull-request merge
- database migration
- production deployment

Production deployment is denied by default.

## Design rule

A coding agent must not silently bypass the runtime permission model by falling back to raw shell commands for an operation that has a registered protected capability.

Enforcement of this rule will be added as orchestration and MCP layers are implemented.
