# Guided onboarding and health

M16 defines one canonical extension health state:

- READY
- NEEDS_SETUP
- NEEDS_REPAIR

## Classification

NEEDS_REPAIR takes precedence when runtime integrity fails or a required Kilo MCP registration is stale.

NEEDS_SETUP covers opened/attached workspace state, managed config, required engineering tools, and optional Kilo installation when auto-connect is enabled.

The Kilo Gateway API key is optional and does not block READY because MCP-driven usage does not require it.

## Get Ready

Command:

    LLMatic: Get Ready

The guided flow:

1. attaches the repository to external LLMatic workspace storage
2. verifies or repairs the versioned MCP runtime
3. derives required repository tools
4. offers only registry-backed installers for missing required tools
5. reports manual required-tool gaps
6. reconciles Kilo MCP when Kilo is installed
7. opens the Kilo extension listing when Kilo is required but missing
8. re-evaluates canonical health

No LLMatic files are added to the opened repository.

## UI

The same health state drives:

- status bar
- LLMatic Activity Bar Runtime Status view
- Show Status
- onboarding prompt

This prevents the UI surfaces from disagreeing about whether the runtime is ready.
