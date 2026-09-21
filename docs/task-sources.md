# Universal task sources

M20 removes Jira as a required workflow dependency.

## Canonical task model

All providers normalize tasks into:

- provider
- key/id
- summary/description
- lifecycle: todo / in_progress / blocked / done / unknown
- acceptance criteria
- Definition of Done
- dependencies
- labels/assignee/priority when available
- source metadata

Workflow selection/validation/sync use the provider-neutral task contract.

## Auto detection

Default priority:

1. local Markdown task file
2. configured Jira
3. GitHub Issues when the repository has a GitHub origin and authenticated `gh`
4. manual reference fallback

An explicit provider always overrides auto detection.

## Markdown provider

Recognized files:

- TASKS.md
- Tasks.md
- tasks.md
- TODO.md
- Todo.md
- todo.md

Task heading example:

    ## TASK-101 — Add parcel API

Supported sections:

    Status: Todo

    ### Description
    ...

    ### Acceptance criteria
    - ...

    ### DoD
    - ...

    ### Dependencies
    - TASK-099

The provider changes only the selected task block when updating status or Notes.

`task next` returns the first Todo task whose declared dependencies exist and are Done.

## GitHub Issues provider

Uses local authenticated GitHub CLI with structured arguments.

It supports:

- get
- list
- next
- comment
- complete/close
- reopen

Issue body sections can carry Acceptance criteria, DoD and Dependencies.

## Jira provider

Existing Jira commands remain backward-compatible.

New provider-neutral commands can select Jira explicitly with:

    --provider jira

## Manual provider

Manual references allow a workflow to start even when no external task system exists.

Manual tasks intentionally have no external comment/transition target.

## MCP

Provider-neutral MCP tools:

- llmatic_task_detect
- llmatic_task_list
- llmatic_task_next
- llmatic_task_get
- llmatic_workflow_select_task
- llmatic_workflow_validate_task
- llmatic_workflow_sync_task

MCP never self-approves taskRead/taskWrite permissions configured as `ask`.
