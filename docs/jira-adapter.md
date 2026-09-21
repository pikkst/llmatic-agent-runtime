# Jira task provider

M9 adds a provider-neutral task contract and a Jira Cloud REST v3 adapter.

## Environment

For Jira Cloud site Basic auth:

    LLMATIC_JIRA_BASE_URL=https://your-site.atlassian.net
    LLMATIC_JIRA_EMAIL=user@example.com
    LLMATIC_JIRA_API_TOKEN=...

For OAuth/bearer access, provide the Atlassian API base that already includes the cloud resource path:

    LLMATIC_JIRA_BASE_URL=https://api.atlassian.com/ex/jira/<cloud-id>
    LLMATIC_JIRA_BEARER_TOKEN=...

Optional browser URL when the REST base is not the Jira site URL:

    LLMATIC_JIRA_SITE_URL=https://your-site.atlassian.net

Credentials are read from environment variables only. They are never written to `llmatic.agent.yaml`, workflow checkpoints, or repository cache.

## Permissions

Task reads use:

    permissions.taskRead

Default: `auto`.

Task comments and transitions use:

    permissions.taskWrite

Default: `ask`.

MCP never self-approves `ask`; unattended Jira writes therefore require the user to explicitly configure `taskWrite: auto`.

## CLI

Read a task:

    llmatic jira get KT-123

List transitions:

    llmatic jira transitions KT-123

Add a comment:

    llmatic jira comment KT-123 --text "CI green" --approve

Transition by name or ID:

    llmatic jira transition KT-123 --to Done --approve

## Workflow

Select the Jira issue:

    llmatic workflow select-jira KT-123

The adapter fetches the issue first, then starts:

    TASK_SELECTED

Validate/refresh the selected issue:

    llmatic workflow validate-jira

On success:

    TASK_SELECTED -> TASK_VALIDATED

Then the existing runtime continues:

    llmatic workflow analyze
    llmatic workflow branch ...
    ...
    llmatic workflow merge

After or during the workflow, evidence can be synchronized back:

    llmatic workflow sync-jira \
      --comment "Merged PR #123; CI green" \
      --transition Done \
      --approve

This does not change the runtime workflow state.

## Jira API mapping

The adapter uses Jira Cloud REST API v3:

- GET issue
- GET issue transitions
- POST issue comment
- POST issue transition

Jira descriptions are Atlassian Document Format (ADF); the adapter converts common text/paragraph/heading/list content to compact plain text for model consumption. Comments are sent as ADF documents.

## Provider contract

`@llmatic/task-provider` defines the stable provider-neutral task types and operations. Jira is the first adapter; future providers can implement the same contract without changing workflow core.
