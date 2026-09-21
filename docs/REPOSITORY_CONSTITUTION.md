# Repository Constitution and Engineering Policy

LLMatic treats an existing repository as a project with its own engineering constitution rather than as an unstructured collection of source files.

The constitution is evidence-based and keeps three concepts separate:

```text
FACTS
  deterministic repository/tool evidence

RULES
  explicit repository policy or human-approved LLMatic policy

REASONING
  model recommendations based on facts + rules + current work state
```

A model recommendation never silently becomes a repository rule.

## Sources

Repository analysis can inspect bounded non-secret policy/documentation sources such as:

- `AGENTS.md` / `AGENT.md`
- `CONTRIBUTING.md`
- `DEVELOPMENT.md`
- `SECURITY.md`
- review-policy Markdown files
- `README.md`
- `docs/**/*.md`
- `.github/**/*.md`
- GitHub workflow YAML as policy evidence
- `package.json` quality scripts/tool declarations
- repository structure and test-file conventions

Runtime constitution state is cached outside the repository when the VS Code extension uses a managed workspace.

## Entry classes

### Fact

A deterministic observation, for example:

```text
Quality script test = vitest run
Repository declares TypeScript
```

Facts are context, not policy.

### Explicit rule

A normative statement found in repository-controlled documentation.

Example:

```text
New API endpoints must update the canonical API contract in the same change.
```

Each rule includes provenance:

```text
id
source path
source line
strength
confidence
scope
```

Strong normative terms such as `must`, `required`, `do not`, `never`, `only` and `shall` can produce blocking project rules.

### Inferred convention

A repeated repository pattern, for example a dominant test-file naming style.

Inferred conventions are advisory. They cannot become the sole reason for a blocking review finding.

### Proposed rule

LLMatic may propose a durable rule when repeated engineering evidence suggests one.

A proposal is stored outside the repository and is not enforced.

### Approved rule

A proposed rule becomes active only after explicit human approval in the VS Code UI.

Rejected proposals are not enforced.

## Controlled learning

The review engine stores bounded review history outside the repository.

When the same semantic finding appears in at least three separate reviews and is not already linked to an active rule, LLMatic can create a rule proposal using the finding's recommended remediation.

Flow:

```text
repeated review finding
  -> proposal
  -> human review
       -> approve -> active rule
       -> reject  -> not enforced
```

The model cannot self-approve policy.

## Review policy

VS Code review runs these lenses:

```text
General Engineering Review
Bug Hunter
Security
```

Bug Hunter focuses on concrete changed-code evidence for issues such as:

- null/undefined and edge-case handling
- state-machine errors
- race conditions
- pagination
- idempotency
- transaction boundaries
- retry semantics
- time/date ordering
- stale state
- resource leaks
- migration/backfill hazards
- missing regression coverage

Security focuses on relevant changed-code evidence for:

- authentication and authorization
- tenant isolation
- injection
- XSS / CSRF / SSRF
- path traversal
- secret exposure
- unsafe file handling
- webhook verification
- insecure defaults
- privilege escalation
- trust-boundary regressions

A finding must be supported by repository evidence. A model is explicitly instructed not to fabricate findings or rule IDs.

When a finding violates an active explicit/approved repository rule, the report records the exact rule ID and source.

## Living architecture

Repository constitution review complements, rather than replaces, the existing deterministic living-architecture gate.

A review may therefore be blocked by:

```text
concrete code finding
repository-rule violation
unresolved architecture/API/schema/security/testing/task-graph synchronization
```

## Workspace recovery

For an existing repository, LLMatic combines:

```text
repository map
constitution
current branch
working tree
active workflow
task provider
active/next task
open PR
remote CI
latest review
```

into one recommended next action.

The recommendation is reasoning; the underlying facts and rules remain separately inspectable.

## Agent Chat tools

The direct Agent Chat may use bounded tools for:

- repository search/read/write
- live Jira/Markdown/GitHub task reads
- task workflow start
- repository workflow analysis
- feature-branch creation subject to repository-write permission
- local quality gates
- repository constitution inspection
- repository rule proposal creation
- PR/CI status
- failed GitHub Actions log diagnostics

It does not receive arbitrary shell execution, package installation, Git push, PR merge, production deployment or remote database mutation capabilities.

## PR draft evidence

LLMatic can generate a PR draft without creating a remote pull request.

The draft uses captured evidence for:

- task and workflow
- branch/base
- changed files
- acceptance criteria / DoD
- quality-gate checkpoints
- review findings
- Bug Hunter / Security lenses
- architecture impact
- repository rules

Missing evidence is written as `not captured`; LLMatic does not invent a passing test, completed review, security conclusion or rollback plan.

## Human-control boundary

Consequential operations remain permission-gated.

Repository constitution learning follows this rule:

```text
observe freely within read permission
reason and recommend
propose policy
require human approval to enforce new policy
```
