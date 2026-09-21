# Approval and initialization

M23 is the human control boundary between private planning and repository mutation.

## Review flow

Use:

    LLMatic: Review & Approve Project Plan

Available actions:

1. Review plan artifacts
2. Edit decisions
3. Regenerate plan
4. Request changes
5. Approve & Initialize

## Approval integrity

Approval records:

- current plan ID
- SHA-256 of the complete private plan bundle
- SHA-256 of the discovery session
- discovery session ID
- approval timestamp
- approved-by = user

Initialization recalculates both digests.

Approval is invalid when:

- a new plan becomes current
- any approved plan artifact changes
- discovery decisions change
- the user requests plan changes

## Edit decisions

Editing a discovery decision reopens discovery at that question.

That question and every later dependent discovery answer are cleared before the guided wizard resumes.

This avoids carrying stale tenancy, persistence, deployment, security or testing decisions after an earlier architectural choice changes.

## Initialization boundary

Initialization currently requires a greenfield repository.

Allowed pre-existing entries are limited to Git metadata plus conventional README/license/editor/gitignore metadata.

The initializer refuses to overwrite target files.

After verified approval it:

1. materializes approved planning artifacts
2. writes TASKS.md
3. writes the approved-plan evidence record
4. creates only the minimal architecture-shaped directory scaffold
5. verifies materialized plan bytes
6. verifies/remediates registry-backed required foundation tools
7. loads the Markdown task graph
8. selects the first dependency-unblocked task
9. records READY_FOR_IMPLEMENTATION

If initialization fails after creating files, files created by that initialization attempt are rolled back.

## Agent boundary

MCP exposes only:

    llmatic_plan_approval_status

This is read-only.

No MCP tool can:

- approve a plan
- initialize a project
- bypass the human approval digest
- push Git
- create/merge a PR
- mutate a remote database
- deploy
