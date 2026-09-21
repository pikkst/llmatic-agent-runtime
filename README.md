# LLMatic Agent Runtime

Universal local software-engineering runtime for coding agents.

LLMatic Agent Runtime gives coding agents a deterministic, repository-aware capability layer instead of forcing every model to rediscover project-specific commands, tools, repository structure, and quality gates.

## Current milestone

M6 — Repository Intelligence

Implemented:

- repository/package-manager/technology/tool detection
- structured capability execution
- persistent workflow state and checkpoints
- state-aware local validation orchestration
- agent-neutral tool registry with controlled installers
- protected Git adapter
- repository file index
- TypeScript/JavaScript AST symbol index
- import/re-export graph edges
- deterministic repository search
- workflow-aware repository analysis

## Useful commands

    llmatic detect
    llmatic doctor

    llmatic repo index
    llmatic repo search WorkflowStateStore
    llmatic workflow analyze

    llmatic tools list
    llmatic git status
    llmatic validate

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

Later milestones attach GitHub/PR/remote-CI/MCP/task-provider adapters to the remaining states.

## Architecture

Coding agents are clients of the runtime.

Kilo Code, Codex, Claude Code, Cline, local LLMs, or other clients should eventually use the same deterministic operations through CLI and MCP interfaces.

Core owns workflow semantics. Tool installation, Git mutations, and repository intelligence are separate packages that depend on core contracts.

## Development

Requirements:

- Node.js 20+
- pnpm

Install dependencies:

    corepack enable
    pnpm install

Validate:

    pnpm ci:local

Build:

    pnpm build

## Roadmap

Next milestones add:

1. GitHub adapter
2. MCP server
3. task-provider adapters such as Jira
4. Docker, Supabase, Python, and local-LLM tool packs
5. automated code-review and remote-CI orchestration
6. controlled PR/merge/deploy actions

See docs/architecture.md, docs/security-model.md, docs/workflow-state.md, docs/orchestration.md, docs/tools.md, docs/git-adapter.md, and docs/repo-intelligence.md.
