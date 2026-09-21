# Local validation orchestration

M3 introduces the first state-aware orchestration loop.

The runtime can now run the repository's configured required quality gates and advance workflow state from the results.

## Command

    llmatic validate

Equivalent nested command:

    llmatic workflow validate

If a required capability is configured with permission `ask`:

    llmatic validate --approve

## Allowed starting states

Local validation may start from:

- IMPLEMENTING
- FIXING
- LOCAL_VALIDATION

When started from IMPLEMENTING or FIXING, the runtime first transitions to LOCAL_VALIDATION.

## Success path

For each configured gate in `workflow.requiredGates`:

1. resolve the detected capability
2. enforce runtime permission
3. execute through structured executable arguments
4. persist a capability checkpoint
5. stop immediately on failure

If all gates pass:

    LOCAL_VALIDATION -> CODE_REVIEW

## Failure path

If any gate returns a non-zero exit code:

    LOCAL_VALIDATION -> FIXING

The failing capability result is persisted before the state transition.

This gives the next agent invocation enough durable information to understand why the workflow is in FIXING.

## Guardrails

The local validation orchestrator intentionally supports only:

- format
- lint
- typecheck
- test
- build

The `ci` capability is not accepted inside `workflow.requiredGates` because invoking the local CI pipeline recursively from the validation orchestrator would create a self-call loop.

External mutations such as push, pull-request creation, merge, database migration, and deployment are not part of this orchestrator.
