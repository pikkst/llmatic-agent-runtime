# Workspace bootstrap and remediation

M13 adds repository-aware bootstrap planning to the VS Code extension.

## Command

    LLMatic: Bootstrap Workspace

The command:

1. attaches the current repository to external LLMatic workspace storage
2. detects repository technologies and package manager
3. inspects the registered engineering toolchain
4. derives required/recommended/optional tools
5. offers installation only for missing tools with a registered controlled installer
6. reconciles the global Kilo MCP registration
7. reports manual gaps without modifying project files

## Requirement levels

Required:

- Node.js
- Git
- pnpm when the repository declares pnpm

Recommended:

- GitHub CLI
- Docker when Docker/Compose files are detected
- Supabase CLI when supabase/config.toml is detected
- Deno when deno.json/deno.jsonc is detected
- Python when Python project/source files are detected

Optional:

- uv for Python workflows
- Ollama for local model execution

## Controlled remediation

M13 does not invent operating-system install commands.

It reuses the runtime Tool Registry. An installer may run only when:

- the tool definition contains an explicit structured installer
- the user confirms installation in VS Code
- the workspace permission allows installation or the human confirmation supplies one-off approval

Today pnpm/Corepack is the first automated installer.

Detection-only tools remain visible as manual setup gaps until platform-specific installer packs are registered.

## Zero-repo guarantee

Bootstrap writes runtime state/config outside the repository and may update only the repository-local .git/info/exclude fallback list.

It does not add package dependencies, scripts, AGENTS files, tool documentation, or LLMatic runtime folders to the tracked repository.
