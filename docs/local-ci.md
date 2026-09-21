# Local CI

LLMatic Agent Runtime keeps the local and hosted CI quality gates aligned.

## Canonical command

After dependencies are installed:

    pnpm ci:local

The pipeline is fail-fast and executes:

1. environment verification
2. formatting verification
3. TypeScript typecheck
4. test suite
5. production build
6. compiled CLI detect smoke test
7. compiled CLI doctor smoke test

## Windows

PowerShell wrapper:

    .\scripts\ci-local.ps1

For a fresh clone, the wrapper can install dependencies first:

    .\scripts\ci-local.ps1 -Install

The wrapper uses Corepack so a separately installed global pnpm is not required.

## macOS / Linux

    ./scripts/ci-local.sh

For a fresh clone:

    ./scripts/ci-local.sh --install

## Hosted CI

GitHub Actions installs dependencies and runs:

    pnpm ci

Both `pnpm ci` and `pnpm ci:local` execute the same Node-based pipeline. This prevents the local acceptance path from drifting away from hosted CI.
