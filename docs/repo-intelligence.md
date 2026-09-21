# Repository intelligence

M6 adds a durable repository index so coding agents can query repository structure without rediscovering it from scratch on every task.

## Build an index

    llmatic repo index

Machine-readable output:

    llmatic repo index --json

The index is written to:

    .llmatic/cache/repo-index.json

or the configured runtime cache directory.

## What is indexed

All non-ignored regular files are recorded with:

- repository-relative path
- extension
- language classification
- byte size
- whether source AST indexing was performed

TypeScript and JavaScript family files up to 2 MiB are parsed with the TypeScript compiler API.

The AST index records:

- functions
- classes
- class methods
- interfaces
- type aliases
- enums
- variables
- imports
- re-exports

## Default excluded directories

- .git
- .llmatic
- node_modules
- dist
- build
- coverage
- .next
- .turbo
- .cache
- target

Symbol extraction therefore avoids dependency and generated-output noise by default.

## Search

    llmatic repo search ExampleService
    llmatic repo search "@llmatic/core"
    llmatic repo search workflow --limit 10

Search matches symbol names, file paths, import specifiers, and imported names. Exact symbol matches receive the highest score.

## Workflow integration

    llmatic workflow analyze

Requires:

    TASK_VALIDATED

On a successful index build:

    TASK_VALIDATED -> REPO_ANALYZED

The operation records an ACTION checkpoint with file, symbol, and import counts before changing state.

If indexing fails, the workflow remains in TASK_VALIDATED and a failed ACTION checkpoint is stored.

## Permission boundary

Building the index uses:

    permissions.repositoryRead

The default is automatic. If configured as `ask`, the caller must pass `--approve`.

The indexer is read-only with respect to project source files; its only write is the runtime cache artifact.
