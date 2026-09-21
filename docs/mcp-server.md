# MCP server

M8 exposes the LLMatic runtime as an agent-neutral MCP server.

The implementation uses the stable MCP TypeScript SDK v2 and serves stdio through `serveStdio`.

## Start

Build first:

    pnpm build

Run:

    pnpm mcp

or:

    node apps/mcp-server/dist/index.js

The server writes protocol messages only to stdout. Startup/logging uses stderr so it cannot corrupt JSON-RPC framing.

## Default root

Each tool accepts an optional `root`.

When omitted, the server resolves in this order:

1. `LLMATIC_ROOT`
2. current working directory

## Tool surface

Read/query tools:

- llmatic_detect
- llmatic_workflow_status
- llmatic_repo_search
- llmatic_git_status
- llmatic_github_pr_status
- llmatic_tools_list

Workflow/local tools:

- llmatic_workflow_start
- llmatic_workflow_transition
- llmatic_workflow_analyze
- llmatic_git_stage
- llmatic_git_commit
- llmatic_workflow_branch
- llmatic_run_capability
- llmatic_workflow_validate
- llmatic_workflow_push
- llmatic_workflow_open_pr
- llmatic_workflow_remote_ci
- llmatic_workflow_merge

## Approval boundary

MCP tools intentionally do not expose an `approve=true` argument.

An AI model must not be able to satisfy a permission configured as `ask` by approving itself.

Therefore:

- `auto` operations may run through MCP
- `ask` operations return the runtime permission error
- `deny` operations remain prohibited

For unattended MCP automation, the user must explicitly change the relevant permission in `llmatic.agent.yaml` to `auto`.

The CLI keeps its explicit `--approve` path for human-driven one-off approval.

## Host configuration

An MCP host can launch the built server with a command equivalent to:

    node /absolute/path/to/llmatic-agent-runtime/apps/mcp-server/dist/index.js

Set `LLMATIC_ROOT` when the host should bind the server to one repository without passing `root` on every tool call.

## Testing

MCP integration tests use the v2 SDK's in-memory linked transport and real `Client.listTools()` / `Client.callTool()` calls. This validates the registered JSON schemas and the protocol-facing tool surface without spawning a child process.
