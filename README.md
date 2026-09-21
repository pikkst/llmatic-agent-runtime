# LLMatic Agent Runtime

Universal local software-engineering runtime for coding agents.

LLMatic Agent Runtime gives coding agents deterministic, repository-aware engineering capabilities while keeping workflow state, permissions, validation, repository intelligence, Git, GitHub, task providers, and tool execution outside the model prompt.

## Current milestone

M9 — Task Provider + Jira

Implemented:

- persistent workflow state and audit checkpoints
- capability discovery and local validation
- controlled tool registry
- protected Git adapter
- repository AST/import intelligence
- protected GitHub PR/CI/merge adapter
- MCP v2 stdio server
- provider-neutral task contract
- Jira Cloud REST v3 task adapter
- Jira-backed workflow task selection/validation
- Jira comment/transition synchronization

## Jira-first workflow

    Jira issue
      -> TASK_SELECTED       # llmatic workflow select-jira KT-123
      -> TASK_VALIDATED      # llmatic workflow validate-jira
      -> REPO_ANALYZED       # llmatic workflow analyze
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
      -> Jira sync           # comment / transition

The same primitives are exposed through MCP. MCP never self-approves permissions configured as `ask`.

## Jira credentials

Use environment variables only. See `docs/jira-adapter.md`.

## Development

    corepack enable
    pnpm install
    pnpm ci:local
    pnpm build

## Roadmap

Next milestones add:

1. Docker / Supabase / Python / local-LLM tool packs
2. automated code-review orchestration
3. richer task-provider mapping and Jira field policy
4. deployment adapters and release policy gates
5. optional Streamable HTTP MCP serving

See the documents under `docs/`.
