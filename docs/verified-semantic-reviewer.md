# Verified Semantic Reviewer Plan

Status: active implementation plan.

Owner scope: LLMatic external pull-request review and Auto Review Agent.

Tracking principle: this document records the architecture, implementation phases, acceptance gates and quality targets required before LLMatic review is treated as a dependable engineering review system rather than an LLM-only review bot.

## Goal

Build a reviewer that understands:

- what the task was supposed to achieve
- which repository rules and invariants apply
- what code and contracts actually exist at the reviewed PR head
- which symbols, callers, tests and interfaces are affected by a change
- which candidate findings are proven, disproven or still inconclusive
- whether the reviewed head is safe to publish against

The core policy is:

> A model may propose a problem. Only evidence may publish a finding.

LLM output is therefore treated as a hypothesis generator, not as the authority for whether a GitHub review finding is true.

## Target review architecture

    PR / task context
      -> Review Contract
      -> Semantic Code Intelligence
      -> Impact Graph / Impact Packets
      -> AI Critics
      -> Candidate Findings
      -> Evidence Verifiers
      -> VERIFIED | REJECTED | INCONCLUSIVE
      -> Coverage Matrix
      -> Review Decision
      -> exact-head GitHub publication

### 1. Review Contract

The review contract is the authoritative statement of what the change is expected to do.

Inputs can include:

- Jira issue acceptance criteria and Definition of Done
- PR title/body
- local Markdown task source
- repository Constitution
- explicit architecture/security/API/schema invariants
- required CI gates

The contract must be normalized before model review. Models should not receive hundreds of unrelated repository rules when only a small subset is relevant to the affected subsystem.

Required properties:

- exact task identity
- requirement provenance
- applicable AC/DoD
- affected domains
- relevant explicit repository rules
- relevant architecture/security invariants
- required evidence types
- exact PR head SHA

### 2. Semantic Code Intelligence

The reviewer must resolve code facts using language-aware tooling instead of asking an LLM to guess from a bounded diff.

TypeScript/JavaScript first implementation:

- TypeScript Compiler API Program
- TypeChecker symbol/type resolution
- definitions
- references
- implementations where available
- imports/exports
- member/property existence
- function/method signatures
- type alias and enum members
- test references

Longer-term provider abstraction:

    CodeIntelligenceProvider
      -> TypeScriptCompilerProvider
      -> SCIPProvider
      -> TreeSitterFallbackProvider

Tree-sitter is syntax-level fallback, not the authority for type/member claims.

Relevant upstream references:

- TypeScript Compiler API: https://github.com/microsoft/TypeScript/wiki/Using-the-Compiler-API
- SCIP / precise code navigation: https://sourcegraph.com/docs/code-navigation/precise-code-navigation
- Tree-sitter: https://tree-sitter.github.io/tree-sitter/

### 3. Impact Graph and Impact Packets

Do not review arbitrary file batches as the primary semantic unit.

For every changed symbol or hunk, construct an Impact Packet containing only the context required to reason about that change:

    changed hunk
      + owning symbol
      + definition/type
      + relevant callers/callees
      + implementations
      + imports/exports
      + tests
      + related task requirements
      + relevant repository rules
      + architecture/API/schema/security edges

This should reduce both token usage and cross-batch hallucination.

Example:

    changed: geminiServer.ts -> finding.summary
    definition: ExplanationFindingInput.summary?: string
    references: grounding.ts, outputValidation.ts
    tests: geminiServer.test.ts
    requirement: Jira KT-121 AC-4

A reviewer must not infer repository-wide absence from an Impact Packet.

### 4. Candidate Findings

Model output should evolve from final GitHub findings to structured hypotheses.

Example:

    {
      "claim_type": "missing_type_member",
      "subject": {
        "symbol": "ExplanationFindingInput",
        "member": "summary"
      },
      "hypothesis": "The trust boundary references a member that may not exist",
      "affected_path": "src/server/explanation/geminiServer.ts"
    }

Candidate findings are not user-visible review findings.

Positive observations such as "this satisfies the DoD" or "no change needed" are never findings. They may contribute to coverage evidence or summary text.

### 5. Evidence Verifiers

Each high-risk claim type must have a deterministic or tool-backed verifier where possible.

Initial verifier registry:

| Claim type                          | Verification source                              |
| ----------------------------------- | ------------------------------------------------ |
| missing type/interface/class member | TypeScript TypeChecker / exact-head source       |
| duplicate union/enum member         | AST / exact-head source                          |
| undefined symbol                    | compiler symbol resolution                       |
| signature mismatch                  | TypeChecker                                      |
| unused symbol                       | semantic reference index                         |
| missing implementation/reference    | semantic reference index                         |
| missing test                        | symbol-to-test evidence search                   |
| API contract mismatch               | route/schema inventory                           |
| repository-rule violation           | exact active rule + source                       |
| DoD/AC violation                    | exact requirement + implementation/test evidence |
| determinism violation               | static rule + targeted test evidence             |
| security/dataflow claim             | Semgrep/CodeQL-compatible verifier adapter       |

Possible external analyzers:

- CodeQL: https://docs.github.com/en/code-security/concepts/code-scanning/codeql/codeql-code-scanning
- Semgrep: https://semgrep.dev/docs/

Verifier outcome:

    VERIFIED
    REJECTED
    INCONCLUSIVE

Only VERIFIED findings may be published to GitHub.

INCONCLUSIVE may reduce coverage but must not become an inline accusation.

### 6. Multi-critic review

General, Bug Hunter and Security remain useful as independent critics, but their output feeds the candidate pool.

A single model is never the final authority.

Preferred pipeline:

    General critic
    Bug Hunter critic
    Security critic
      -> deduplicated candidate pool
      -> deterministic verification
      -> optional evidence-only adjudicator
      -> final report

An adjudicator receives only the candidate, verification evidence, relevant code slice and requirement/rule provenance. It should not reread the whole repository.

### 7. Coverage Matrix

A failed free model must not by itself make the complete review partial.

Coverage is tracked by review dimension and impact area.

Example:

    requirement coverage       complete
    changed-symbol coverage    complete
    type verification          complete
    security static checks     complete
    bug critic                 incomplete

Overall review is partial only when a material requirement, changed impact area or required verification dimension remains uncovered.

Provider/schema/timeouts are implementation failures, not automatically business-level review gaps.

### 8. CI and publication policy

Review publication must remain exact-head safe.

Rules:

- re-check PR head before publication
- never publish findings created for an older SHA
- APPROVE intent is gated by required CI only
- advisory review bots/checks do not block APPROVE
- blocking VERIFIED findings may produce REQUEST_CHANGES regardless of advisory CI
- partial/inconclusive review publishes COMMENT, never APPROVE
- self-authored APPROVE/REQUEST_CHANGES may fall back to COMMENT due to GitHub restrictions

## Implementation phases

### Phase R0 — Reliability foundation

Status: completed in PR #42.

Implemented or already proven:

- [x] transient model/provider fallback
- [x] longer review timeout for thinking-capable free models
- [x] schema-repair loop with failed-model avoidance
- [x] bounded split recovery
- [x] preserve successful split findings when sibling recovery fails
- [x] exact-head publication guard
- [x] Jira task resolution from PR title/branch
- [x] Jira AC/DoD extraction and reviewer evidence injection
- [x] mark DoD coverage partial if linked Jira evidence cannot be loaded
- [x] required-CI path separated from advisory checks
- [x] typed-member absence claim verification against exact PR head
- [x] positive DoD observations filtered from findings
- [x] duplicate union-member candidate verification against exact PR head
- [x] share failed-model avoidance across batch recovery attempts
- [x] PR #42 CI green after latest reliability changes
- [x] live regression smoke with Jira-backed Krunditark PR
- [x] PR #42 merged

### Phase R1 — Review Contract

Status: in progress on `feat/reviewer-review-contract`.

- [x] introduce normalized ReviewContract type
- [x] merge Jira/Markdown/GitHub Issue/PR acceptance evidence with provenance
- [x] select relevant repository rules instead of sending the entire Constitution
- [x] attach applicable architecture/security/API/schema invariants from relevant explicit/approved rules
- [x] expose review-contract telemetry
- [x] fail closed when authoritative linked task evidence is expected but unavailable
- [x] fail closed when one task reference resolves in multiple providers
- [x] route reference syntax only to compatible providers
- [ ] live smoke confirms the resolved provider/task and Review Contract telemetry on a real PR

Acceptance gate:

- one PR can show exactly which task requirements and repository rules were used
- irrelevant rules are excluded from critic prompts
- conflicting task identities do not resolve by guess

### Phase R2 — Semantic Code Intelligence

Status: planned.

- [ ] create CodeIntelligenceProvider interface
- [ ] implement TypeScript Compiler API provider
- [ ] resolve changed symbols and owning declarations
- [ ] resolve type/member existence
- [ ] resolve definitions and references
- [ ] resolve imports/exports
- [ ] resolve relevant test references
- [ ] cache semantic graph by exact head SHA
- [ ] add fallback behavior for unsupported languages

Acceptance gate:

- PR #210-style missing-member false positive is impossible without compiler evidence
- semantic answers are derived from exact reviewed SHA
- changing the PR head invalidates the semantic cache

### Phase R3 — Impact Packets

Status: planned.

- [ ] replace arbitrary file batching as the primary review unit
- [ ] derive changed-symbol impact graph
- [ ] include related definitions/callers/tests/contracts
- [ ] attach relevant AC/DoD and rules
- [ ] enforce packet size budgets
- [ ] record uncovered graph edges in coverage

Acceptance gate:

- a cross-file contract change is reviewed with its definition and affected consumers
- packet growth is bounded
- no repository-wide absence claim is inferred from omitted context

### Phase R4 — Candidate Finding + Verifier Registry

Status: planned.

- [ ] introduce CandidateFinding schema
- [ ] add typed claim_type values
- [ ] add verifier registry
- [ ] migrate missing-member and duplicate-member checks into registry
- [ ] add compiler-backed undefined-symbol/signature/reference verifiers
- [ ] add DoD/rule provenance verification
- [ ] add determinism verifier hooks
- [ ] add optional CodeQL/Semgrep adapter interface
- [ ] publish only VERIFIED findings

Acceptance gate:

- unverified model claims never reach GitHub
- verifier evidence is visible in Review Activity telemetry
- a deliberately injected real defect survives verification

### Phase R5 — Coverage Matrix and Adjudication

Status: planned.

- [ ] track coverage by requirement, changed symbol and risk dimension
- [ ] distinguish provider failure from review coverage failure
- [ ] add evidence-only adjudicator for conflicting critics/verifiers
- [ ] allow redundant evidence to satisfy a lens despite one provider failure
- [ ] define complete/partial deterministically

Acceptance gate:

- one model timing out does not automatically make the review partial
- a real uncovered impact area does make the review partial
- final status explains exactly what remains unverified

### Phase R6 — Reviewer Benchmark and Release Gate

Status: planned.

Build a stable regression corpus from:

- historical real PRs with human-confirmed findings
- known false positives from LLMatic smoke runs
- known false negatives
- deterministic mutation cases

Initial mutation classes:

- removed type member
- duplicate member
- inverted authorization condition
- missing await
- pagination/off-by-one
- stale cache key
- broken idempotency
- transaction boundary regression
- missing enum case
- locale-sensitive deterministic ordering
- API schema/handler mismatch
- missing regression test

Target quality gates:

| Metric                                        |  Target |
| --------------------------------------------- | ------: |
| Blocking finding precision                    |  >= 98% |
| Overall finding precision                     |  >= 92% |
| Known-defect recall                           |  >= 75% |
| False blocking findings                       |    < 1% |
| Unverified finding publication                |      0% |
| Wrong-head publication                        |      0% |
| Jira task resolution                          |  >= 99% |
| Partial review rate on healthy infrastructure |    < 5% |
| P95 review duration                           | < 5 min |

These numbers are initial engineering targets and may be recalibrated after the benchmark corpus is large enough.

A reviewer release must not regress benchmark precision/recall beyond the accepted tolerance.

## Known regression cases

### Krunditark PR #210

Observed failure:

- reviewer claimed ExplanationFindingInput lacked summary
- exact head showed summary?: string exists
- root cause: cross-batch context + model inference of absence

Expected permanent regression:

- candidate is rejected by semantic/exact-head verification

### Krunditark PR #213

Observed failures:

- model emitted positive DoD observations as blocking findings
- reviewer later claimed a duplicate union member that exact head did not contain
- Bug Hunter spent multiple repair/recovery attempts on length/null-content model failures
- original reviewed head changed before publication

Expected permanent regressions:

- positive observations never become findings
- duplicate claim requires exact-head AST/source proof
- recovery carries failed-model avoidance forward
- provider failure is separated from semantic coverage
- publication remains exact-head safe
- Jira KT-123 AC/DoD is loaded as authoritative evidence

## Research notes

The design intentionally follows several external lessons:

- compiler/code-intelligence evidence is more trustworthy for code facts than model inference
- precise navigation should supply definitions/references instead of dumping the whole repository
- multiple critics can improve recall, but aggregation still requires verification
- larger raw context is not automatically better context
- review quality must be measured on real PRs plus deliberate mutations

Useful references:

- TypeScript Compiler API: https://github.com/microsoft/TypeScript/wiki/Using-the-Compiler-API
- Sourcegraph precise code navigation / SCIP: https://sourcegraph.com/docs/code-navigation/precise-code-navigation
- Tree-sitter: https://tree-sitter.github.io/tree-sitter/
- GitHub CodeQL: https://docs.github.com/en/code-security/concepts/code-scanning/codeql/codeql-code-scanning
- Semgrep: https://semgrep.dev/docs/
- OpenAI CriticGPT research: https://openai.com/index/finding-gpt4s-mistakes-with-gpt-4/

## Working rule

Do not increase prompt size as the default response to reviewer uncertainty.

Prefer:

    exact task contract
    + exact-head semantic facts
    + relevant impact graph
    + bounded critic context
    + deterministic verification

The reviewer is considered trustworthy only when a model cannot publish an unsupported claim merely because it sounded plausible.
