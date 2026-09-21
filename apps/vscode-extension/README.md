# LLMatic Agent Runtime

LLMatic integrates a deterministic local software-engineering runtime with VS Code and Kilo Code.

## What this extension does

- attaches opened repositories without adding runtime state to the repository
- stores workspace config/state/cache in VS Code extension storage
- registers the bundled LLMatic MCP server in Kilo Code global configuration
- preserves Kilo JSONC comments and unrelated settings
- stores optional Kilo Gateway credentials in VS Code SecretStorage
- provides a status-bar health indicator and Doctor command

## Commands

- LLMatic: Attach Workspace
- LLMatic: Connect Kilo Code Globally
- LLMatic: Doctor
- LLMatic: Show Status
- LLMatic: Set Kilo Gateway API Key
- LLMatic: Clear Kilo Gateway API Key
- LLMatic: Reveal Workspace Runtime Data

See the project repository for runtime architecture and security documentation.
