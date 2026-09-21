# Gateway agent orchestrator

M13 adds an optional LLMatic-driven coding-agent loop using the Kilo Gateway.

This is separate from the default Kilo-driven MCP workflow. Kilo can continue to call LLMatic MCP tools without the direct orchestrator.

## Default model

The direct agent defaults to:

    kilo-auto/free

This tier uses no Kilo credits and dynamically routes to available free models.

Change it through:

    llmatic.agentModel

## Auto Free data handling

Kilo documents that Auto Free can route requests to providers that log prompts and outputs and may use them to improve their services.

The VS Code extension therefore shows a one-time modal warning before the first direct Auto Free run.

LLMatic also blocks common secret files from direct-agent file reads, but this does not make Auto Free suitable for confidential source code. Use a model/provider with an appropriate data policy when confidentiality is required.

## Secure authentication

The Gateway API key is read from VS Code SecretStorage.

It is sent only as:

    Authorization: Bearer <key>

to:

    https://api.kilo.ai/api/gateway/chat/completions

It is not included in request JSON, repository files, Kilo JSONC, workflow state, or logs.

## Direct-agent tools

Allowed:

- repo_search
- read_file
- replace_in_file
- create_file
- run_capability
- validate_workflow
- git_status
- workflow_status

Not exposed:

- arbitrary shell
- package install
- Git push
- PR create/merge
- Jira mutation
- Docker/Supabase mutation
- database migration
- deploy

Repository/file tools reject common secret paths and repository escape attempts.

Permissions set to `ask` cannot be self-approved by the direct agent.

## Running

1. Install/configure the VSIX.
2. Store the Kilo Gateway API key with:
   `LLMatic: Set Kilo Gateway API Key`
3. Run:
   `LLMatic: Run Gateway Agent`
4. Enter the implementation/fix instruction.
5. Follow progress in the LLMatic Output channel.

## Agent loop

The orchestrator:

1. sends the system policy + user instruction
2. accepts Gateway function/tool calls
3. executes only the fixed LLMatic tool whitelist
4. returns structured tool results
5. repeats until the model returns a final answer or the step limit is reached

Default maximum: 20 rounds.
Maximum configurable: 50.
