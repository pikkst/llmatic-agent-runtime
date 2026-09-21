# LLMatic Agent Runtime

Universal local software-engineering runtime for coding agents.

LLMatic Agent Runtime gives coding agents deterministic, repository-aware engineering capabilities while keeping workflow state, permissions, local validation, source intelligence, Git, and GitHub operations outside the model prompt.

## Current milestone

M7 — GitHub Adapter

Implemented:

- persistent workflow state and audit checkpoints
- repository detection and capability execution
- local validation orchestration
- tool registry and controlled installers
- protected Git adapter
- repository file/AST/import intelligence
- GitHub pull-request creation
- pull-request and remote-CI status
- workflow-aware PR/CI transitions
- protected merge with exact PR head SHA matching

## Workflow path implemented so far

    TASK_SELECTED
      -> TASK_VALIDATED
      -> REPO_ANALYZED        # llmatic workflow analyze
      -> BRANCH_CREATED       # llmatic workflow branch
      -> IMPLEMENTING
      -> LOCAL_VALIDATION     # llmatic validate
      -> CODE_REVIEW
      -> READY_TO_PUSH
      -> PUSHED               # llmatic workflow push
      -> PR_OPEN              # llmatic workflow open-pr
      -> REMOTE_CI            # llmatic workflow remote-ci
      -> FINAL_REVIEW
      -> READY_TO_MERGE
      -> COMPLETED            # llmatic workflow merge

Failed remote CI moves back to FIXING.

## Useful commands

    llmatic repo index
    llmatic repo search WorkflowStateStore

    llmatic git status
    llmatic tools list

    llmatic github pr status
    llmatic github pr create --title "..." --body "..." --approve
    llmatic github pr merge 123 --approve

    llmatic workflow open-pr --title "..." --body "..." --approve
    llmatic workflow remote-ci
    llmatic workflow merge --approve

## Architecture

Coding agents remain clients of the runtime.

Kilo Code, Codex, Claude Code, Cline, local LLMs, and future MCP clients should invoke the same deterministic operations rather than reimplementing repository-specific engineering process in prompts.

Core owns state and permission contracts. Tool, Git, repository-intelligence, and GitHub behavior live in separate packages.

## Development

Requirements:

- Node.js 20+
- pnpm

Validate:

    pnpm ci:local

Build:

    pnpm build

## Roadmap

Next milestones add:

1. MCP server
2. task-provider adapters such as Jira
3. Docker, Supabase, Python, and local-LLM tool packs
4. automated code-review orchestration
5. deployment adapters and release policy gates

See docs/architecture.md, docs/security-model.md, docs/workflow-state.md, docs/orchestration.md, docs/tools.md, docs/git-adapter.md, docs/repo-intelligence.md, and docs/github-adapter.md.
