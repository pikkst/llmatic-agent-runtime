# Review / fix loop

M14 adds a structured code-review gate and automated fix/re-review cycle.

## Workflow

From CODE_REVIEW:

- no blocking findings -> READY_TO_PUSH
- blocking findings -> FIXING

The fix loop then runs the constrained coding agent, requires local validation to return to CODE_REVIEW, and reviews again.

A failing quality gate cannot be skipped.

## Review context

The reviewer starts with Git changed files and can request:

- bounded current file content
- bounded git diff from HEAD for a changed file
- repository symbol/path/import search

Sensitive paths are filtered before the changed-file list reaches the model.

The reviewer has no write, push, merge, database, deployment, package-install, or arbitrary-shell tool.

## Finding schema

Each model finding must validate as:

- severity: blocking or non_blocking
- category: correctness, security, reliability, tests, or maintainability
- title
- repository-relative path
- optional line
- evidence
- recommendation

Malformed free-form output fails the review rather than changing workflow state.

## VS Code

Commands:

    LLMatic: Run Code Review
    LLMatic: Run Review / Fix Loop

The configured direct-agent model is used. Default:

    kilo-auto/free

The Kilo Gateway key remains in VS Code SecretStorage and the existing Auto Free data-handling warning applies.
