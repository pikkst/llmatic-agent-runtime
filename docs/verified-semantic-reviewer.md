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

Status: closure audit in progress. Review Contract and R1 hardening through PR #50 are merged. Two live-smoke exit gates remain: PR #214 precision/recall re-smoke, and rule-selection relevance below the configured caps without unrelated subsystem rules.

- [x] introduce normalized ReviewContract type
- [x] merge Jira/Markdown/GitHub Issue/PR acceptance evidence with provenance
- [x] select relevant repository rules instead of sending the entire Constitution
- [x] attach applicable architecture/security/API/schema invariants from relevant explicit/approved rules
- [x] expose review-contract telemetry
- [x] fail closed when authoritative linked task evidence is expected but unavailable
- [x] fail closed when one task reference resolves in multiple providers
- [x] route reference syntax only to compatible providers
- [x] live smoke confirms the resolved provider/task and Review Contract telemetry on a real PR
- [ ] re-smoke confirms PR #214 false-positive regression is suppressed while the real truncated-history defect remains publishable
- [ ] re-smoke confirms rule selection stays below the relevance caps without unrelated subsystem rules
- [x] re-smoke confirms hard semantic/transport failures are removed from later work in the same long-running lens
- [x] re-smoke confirms capacity-limited models remain available for smaller recovery work without exhausting the model pool

Closure audit (2026-09-27):

- PR #214 precision/recall behavior is covered deterministically: the false test-literal absence claim is rejected against exact-head source while the real `truncated` history defect remains publishable. The explicit live re-smoke gate is still open.
- PR #238 selected exactly 32 relevant rules and 16 invariants. This proves the new caps are enforced, but because both limits were saturated it does not yet prove the live rule set stays below the caps or excludes all unrelated subsystem rules.
- PR #237, after the PR #46 model-pool changes, demonstrated capacity recovery: a prompt-only model reached `finish=length`, then a JSON-native model completed the batch. Capacity exhaustion is therefore no longer treated as permanent semantic incompatibility for the full lens.
- PR #48 native-JSON routing/build identity, PR #49 strict structured schema, and PR #50 bounded-batch DoD uncertainty filtering are merged. These harden R1 precision but do not replace the two remaining live exit gates above.

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

### Krunditark PR #240 — KT-134 post-merge locale smoke gaps

Observed live-smoke result on head `3418220a9480c44bdce71c6cb689c2e7bf2cc31f`:

- LLMatic produced one real inline defect: ET/EN carried Russian-only `few` / `many` plural suffixes; the fix correctly restored locale-supported plural categories and normalized parity by semantic plural family
- LLMatic also produced two false line-less DoD findings whose only evidence was bounded-batch absence:
  - shared date formatter implementation was "not visible in this batch"
  - Russian plural catalog was "not present in this bounded batch"
- exact-head verification showed both dependencies existed and satisfied the claimed requirements:
  - browser English maps to `en-GB` and shared date formatting pins `Europe/Tallinn`
  - Russian evidence geometry contains the required `few` and `many` variants

Expected permanent regression:

- a DoD/acceptance finding whose evidence is only "not visible / not present / cannot verify from this bounded batch" is rejected before publication
- genuine missing-work DoD findings backed by complete evidence remain publishable
- the real ET plural-category defect remains a positive recall example

### Krunditark PR #238 — KT-133 English critical-flow tests

Observed live-smoke result on build `v0.3.2@513b3f7e1b73`:

- exact build identity and Acceptance evidence telemetry were present
- Review Contract resolved Jira KT-133 with 16 AC/DoD items, 32 relevant rules and 16 invariants
- Bug Hunter correctly selected a JSON-native model ahead of prompt-only alternatives
- the first Bug Hunter response omitted the required top-level `summary` and was correctly rejected/repaired
- the Security response contained valid `summary` + `findings` but also emitted unknown top-level fields (`severity`, `category`, `basis`, `side`, `line`)
- Zod's default object behavior stripped those unknown fields, so the response was incorrectly accepted as schema-valid

Expected permanent regression:

- structured review report objects are strict: unknown top-level keys trigger `invalid_schema` repair
- individual finding objects are strict: unknown finding keys trigger `invalid_schema` repair

### Krunditark PR #237 — KT-132 Russian critical-flow tests

Observed live-smoke result:

- LLMatic completed all three lenses with complete diff coverage and no published findings
- the same exact head later passed repository CI
- a separate Kilo review produced two low-signal comments: nullish-coalescing consistency inside a test assertion and a 1 px overflow tolerance suggestion; neither established a production defect or documented acceptance failure
- structured-output recovery worked: an invalid security report was rejected and repaired to an empty valid report
- capacity recovery worked: a Bug Hunter prompt-only model hit `finish=length`, then a JSON-native model completed the batch
- however, the prompt-only model was selected before an available JSON-native Tier B model and consumed about 1m49s before recovery
- the Auto Review activity log omitted the expected Acceptance evidence line even though the packaged extension bundle contains that stage; exact build identity was not logged, so the active runtime could not be proven from telemetry alone

Expected permanent regressions:

- within the same review-history tier, native structured-output support outranks prompt-only candidates regardless of learned score
- every manual and automatic external review logs extension version + exact source commit
- Acceptance evidence telemetry remains present in both manual and Auto Review source paths

### Krunditark PR #236 — KT-131 privacy-request concurrency

Benchmark provenance:

- this concurrency finding was produced by another external reviewer, not proven to be an LLMatic finding
- human verification confirmed the defect on head `45f025e8c143130e48504dee72aa2c2195b74b3d`
- fix head `090eb9bae3825d22e4e76d68b73b7593307d648f` serializes the same permanent-account + action pair with a transaction-scoped advisory lock

Expected permanent benchmark:

- vulnerable head: the concurrency/idempotency finding remains publishable
- fixed head: the same stale candidate is rejected by exact-head verification
- live-model recall runs may use the vulnerable head to measure whether the critic discovers the race independently
- CI does not depend on a live/free model; deterministic scripted-candidate verification covers the precision/recall boundary

### Krunditark PR #215

Observed live-smoke result after the first R1 hardening merge:

- exact-head publication guard worked: the first publication attempt was rejected when PR head changed
- hard semantic/transport failures were not immediately recycled within the same lens
- long General/Bug Hunter passes exhausted compatible free-model candidates and ended partial despite complete diff coverage
- prompt-only models were still selected ahead of JSON-native alternatives in several batches
- generation-length failures consumed models as if they were permanent semantic incompatibilities
- one blocking SQL privilege finding was false: the migration intentionally denies direct table access, exposes a SECURITY DEFINER recorder RPC, and grants EXECUTE on that RPC to service_role

Expected permanent regressions:

- prefer native structured-output models for review JSON when available
- keep invalid JSON/schema and transport failures out of the active review window
- treat generation-length exhaustion as a capacity signal: avoid within the current attempt, but keep the model eligible for smaller recovery work with learned penalties
- exact-head SQL privilege verification recognizes SECURITY DEFINER + GRANT EXECUTE write paths before claiming a missing direct table GRANT
- model-pool exhaustion should not turn a large but otherwise reviewable PR into a mostly incomplete review

### Krunditark PR #214

Observed live-smoke result:

- Jira KT-124 resolved correctly
- 16 AC/DoD requirements loaded into a complete Review Contract
- Review Contract hit the old maximum of 80 rules / 40 invariants, showing relevance filtering was still too broad
- one real blocking defect was found: history `truncated` metadata became true merely because turns moved outside the six-turn recent window, even when no content was actually clipped/dropped
- one false blocking defect was published: a source-string test was claimed to fail because only an optional-chaining occurrence was noticed, while the exact target file also contained the directly-accessed string the test expected
- prior Kilo review commentary visibly anchored critic reasoning
- failed/limited models were recycled later in the long-running review because cooldowns were shorter than the review duration

Expected permanent regressions:

- prior review comments are not critic evidence
- exact-head test-literal verification rejects a missing-string claim when the literal exists in the real target file
- the real `truncated` correctness defect remains publishable
- one lens shares semantic failed-model avoidance across sibling batches
- review model failures use a review-window cooldown
- rule selection requires actual scope overlap or repository scope and uses lower caps

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
