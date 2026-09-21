# LLMatic Agent Runtime

Universal local software-engineering runtime for coding agents.

LLMatic Agent Runtime gives coding agents deterministic, repository-aware engineering capabilities while keeping workflow state, permissions, validation, repository intelligence, Git, GitHub, and tool execution outside the model prompt.

## Current milestone

M8 — MCP Server

Implemented:

- persistent workflow state and audit checkpoints
- repository/capability detection
- local validation orchestration
- tool registry
- protected Git adapter
- repository file/AST/import intelligence
- protected GitHub PR/CI/merge adapter
- MCP v2 stdio server
- agent-neutral MCP tools for the implemented workflow

The MCP server uses `@modelcontextprotocol/server@2.0.0` and Zod v4 schemas.

## Start MCP

    pnpm build
    pnpm mcp

Optional repository binding:

    LLMATIC_ROOT=/path/to/repository pnpm mcp

Each tool can also receive an explicit `root`.

## MCP permission rule

MCP tools cannot self-approve `ask` permissions.

For unattended automation, explicitly configure the required operation as `auto` in `llmatic.agent.yaml`. Human-driven CLI operations can continue to use `--approve`.

## Workflow

    TASK_SELECTED
      -> TASK_VALIDATED
      -> REPO_ANALYZED
      -> BRANCH_CREATED
      -> IMPLEMENTING
      -> LOCAL_VALIDATION
      -> CODE_REVIEW
      -> READY_TO_PUSH
      -> PUSHED
      -> PR_OPEN
      -> REMOTE_CI
      -> FINAL_REVIEW
      -> READY_TO_MERGE
      -> COMPLETED

The same state machine is now accessible through CLI and MCP.

## Roadmap

Next milestones add:

1. task-provider adapters such as Jira
2. Docker, Supabase, Python, and local-LLM tool packs
3. automated code-review orchestration
4. deployment adapters and release policy gates
5. optional Streamable HTTP MCP serving for remote/multi-client deployments

See docs/mcp-server.md and the adapter/runtime documents under docs/.
