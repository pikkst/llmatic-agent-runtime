# LLMatic Agent Runtime

LLMatic brings a deterministic local software-engineering workflow to VS Code and AI coding agents.

It keeps runtime state outside your repository, integrates with Kilo Code through MCP, and helps you move from project discovery to an approved engineering plan, implementation, validation, review, and task progression.

## Install

### From VS Code Marketplace

1. Open **Extensions** with `Ctrl+Shift+X`.
2. Search for **LLMatic Agent Runtime**.
3. Select **Install**.
4. Open the folder or repository you want to work with.
5. Run **LLMatic: Get Ready**.

CLI:

```text
code --install-extension eventnexus.llmatic-agent-runtime
```

### From a VSIX

Download the matching VSIX from the GitHub Release and use:

```text
Extensions → … → Install from VSIX…
```

or:

```powershell
code --install-extension .\llmatic-agent-runtime-0.1.1.vsix
```

## First run

Open the Command Palette with `Ctrl+Shift+P` and run:

```text
LLMatic: Get Ready
```

Get Ready attaches the workspace externally, verifies the bundled runtime, inspects required project tools, connects Kilo Code when enabled, and validates the global LLMatic MCP registration.

The LLMatic Activity Bar view shows one canonical state:

```text
READY
NEEDS_SETUP
NEEDS_REPAIR
```

## New project workflow

Open an empty folder and run:

```text
LLMatic: Start Project Discovery
```

LLMatic asks what you want to build and guides the major engineering decisions. Discovery is saved outside the repository.

When discovery is complete:

```text
LLMatic: Generate Project Plan
LLMatic: Review & Approve Project Plan
```

The private plan can include:

- product requirements and user journeys
- architecture and ADRs
- data model and API contracts
- security and testing strategy
- operations and observability
- roadmap, TASKS.md, and dependency graph

You can review artifacts, edit decisions, request changes, and regenerate the plan. Requested changes are applied to the next draft.

Repository files remain untouched until you explicitly choose **Approve & Initialize**.

## Existing repository workflow

For an existing codebase:

```text
LLMatic: Get Ready
LLMatic: Doctor
```

Then use LLMatic's agent, review, and task workflows as needed.

Task sources are detected in this order:

```text
TASKS.md / Tasks.md / TODO.md
  -> Jira when configured
  -> GitHub Issues when available
  -> manual workflow references
```

## Kilo Code

Kilo Code is the default coding-agent integration.

LLMatic registers its verified MCP runtime in Kilo Code's global MCP configuration. If Kilo Code is installed while onboarding is in progress, LLMatic resumes Get Ready automatically.

The default direct-agent model is:

```text
kilo-auto/free
```

Configure another model with:

```text
llmatic.agentModel
```

LLMatic shows a data-handling warning before first use of Auto Free. Use an appropriate model/provider for confidential repositories.

## Core commands

```text
LLMatic: Get Ready
LLMatic: Doctor
LLMatic: Repair Runtime
LLMatic: Start Project Discovery
LLMatic: Generate Project Plan
LLMatic: Review Project Plan
LLMatic: Review & Approve Project Plan
LLMatic: Run Gateway Agent
LLMatic: Run Code Review
LLMatic: Run Review / Fix Loop
LLMatic: Check for Updates
LLMatic: Install Latest Update
```

## Safety

LLMatic runtime state is stored in VS Code global storage rather than in the opened repository.

The built-in fix agent does not receive unrestricted shell, package-install, Git push, PR merge, deployment, or remote-database mutation capabilities.

Human approval is required before a greenfield private plan becomes repository state.

Gateway credentials are stored in VS Code SecretStorage.

## Troubleshooting

Start with:

```text
LLMatic: Doctor
```

For runtime integrity problems:

```text
LLMatic: Repair Runtime
```

For Kilo MCP problems:

```text
LLMatic: Connect Kilo Code Globally
```

For setup state:

```text
LLMatic: Get Ready
```

When reporting a bug, include your VS Code version, LLMatic version, operating system, relevant LLMatic output-channel diagnostics, and reproducible steps.

## Support and source

Source code, issue tracking, release artifacts, and engineering documentation:

https://github.com/pikkst/llmatic-agent-runtime

## License

MIT.
