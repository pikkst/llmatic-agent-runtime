# Git adapter

M5 moves common Git mutations behind a deterministic runtime adapter.

## Commands

Read-only status:

    llmatic git status
    llmatic git status --json

Create a branch:

    llmatic git branch feature/TASK-123-description

Stage explicit paths:

    llmatic git stage src/file.ts tests/file.test.ts

Commit already staged changes:

    llmatic git commit -m "feat: implement TASK-123"

Push:

    llmatic git push --approve

## Permissions

Branch creation, staging, and commit use:

    permissions.repositoryWrite

Push uses:

    permissions.gitPush

The default configuration keeps repository writes automatic but requires explicit approval for push.

## Structured execution

Git operations use an executable and argument array. The adapter does not use shell command strings and explicitly disables shell execution, including on Windows.

## Workflow-aware operations

Workflow branch creation:

    llmatic workflow branch feature/TASK-123-description

Requires:

    REPO_ANALYZED

On success:

    REPO_ANALYZED -> BRANCH_CREATED

Workflow push:

    llmatic workflow push --approve

Requires:

    READY_TO_PUSH

On success:

    READY_TO_PUSH -> PUSHED

The state transition happens only after the Git operation succeeds.

Git mutations performed through workflow-aware commands also create ACTION checkpoints with provider `git`, operation name, success state, and relevant detail.

## Commit safety

The commit command intentionally does not stage files automatically.

An agent must explicitly choose paths with `llmatic git stage` before committing. This avoids accidentally sweeping unrelated local files into a commit.
