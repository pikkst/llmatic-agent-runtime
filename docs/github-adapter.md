# GitHub adapter

M7 adds pull-request and remote-CI operations through the local GitHub CLI.

The adapter uses structured `gh` arguments and disables shell execution.

## Requirements

GitHub CLI must be installed and authenticated for the target repository.

Check availability with:

    llmatic tools list

## Pull-request status

    llmatic github pr status
    llmatic github pr status 123
    llmatic github pr status --json

The adapter reads PR metadata with `gh pr view --json` and checks with `gh pr checks --json`.

Check buckets are normalized to:

- passing
- failing
- pending
- cancelled
- none

GitHub CLI exit code 8 for pending checks is treated as a valid status response rather than a command failure.

## Create a pull request

    llmatic github pr create \
      --title "TASK-123 implementation" \
      --body "Summary..." \
      --base main \
      --approve

Creation uses:

    permissions.createPullRequest

## Workflow pull request

    llmatic workflow open-pr --title "TASK-123 implementation" --body "..." --approve

Requires:

    PUSHED

On success:

    PUSHED -> PR_OPEN

The resulting PR number, URL, and head SHA are stored in structured ACTION checkpoint metadata.

## Remote CI

    llmatic workflow remote-ci

The PR reference is recovered from the workflow checkpoint unless `--pr` is supplied.

State behavior:

- PR_OPEN -> REMOTE_CI before result evaluation
- passing -> FINAL_REVIEW
- failing -> FIXING
- cancelled -> FIXING
- pending -> remain REMOTE_CI
- no checks -> remain REMOTE_CI

## Merge

    llmatic github pr merge 123 --method squash --approve

Workflow merge:

    llmatic workflow merge --method squash --approve

Requires:

    READY_TO_MERGE

Merge uses:

    permissions.mergePullRequest

Immediately before merge the adapter reads the current PR head SHA and sends it through:

    gh pr merge <number> --squash --match-head-commit <SHA>

This is an optimistic-concurrency guard: if the PR head changed after review or CI evidence was collected, GitHub rejects the stale merge attempt.

On successful workflow merge:

    READY_TO_MERGE -> COMPLETED
