# 28｜S10 GPT-only baseline ADR

> Decision: **BLOCKED / do not adopt a foreground ingestion arm yet**. This ADR is preflight design, not Pilot authorization or evidence that S10 ran.

## Context

The proposed comparison needs the same base fixture, read/write scope, hidden gate, wall budget, acceptance criteria, isolated worktree, and canonical evidence path for both arms. It must not restore background `codex exec`, an OpenAI API key, provider hot switching, or an unbound reviewer.

The current foreground GPT session can produce a patch, but the host does not expose an auditable exact model ID, underlying provider request count, token/cache usage, list-price cost, invoice cost, or ChatGPT quota. Those values cannot be reconstructed from conversation text. Writing zero would be false; estimating them would make the cost comparison circular.

## Options considered

| Option | Auditability | Main limitation | Decision |
| --- | --- | --- | --- |
| Foreground GPT proposes a structured patch and Router applies/gates it | Scope, preimage, isolation and gates can be shared | Model/request/token/quota still unavailable; proposal is produced in the same contaminated chat | Rejected for S10 cost comparison |
| Add a canonical foreground-proposal ingestion contract | Best future route: proposal hash can bind approval, isolation, apply, gate and evidence | Still cannot fill host telemetry; implementing it now would create a superficially symmetric but economically unmeasurable arm | Deferred, not adopted |
| Use background Codex CLI or OpenAI API | Could expose more telemetry | Violates the foreground-only/provider/auth boundary and revives the legacy unbound path | Rejected |
| Treat foreground telemetry as N/A | Honest | Core 30% cost-reduction question becomes unanswerable | Selected representation; blocks expansion |

## Decision

No GPT-only proposal ingestion runtime is adopted in this stage, so no ingestion-path test is required. The Pilot schema represents unavailable foreground model, provider HTTP request count, token/cache usage, list estimate, invoice and quota as `null`, accompanied by explicit `core_metrics_unavailable` entries. The fixed pair decision gate turns that state into `core_evidence_unavailable` and recommendation `stop`.

This does not claim that the hybrid arm is worse or that a foreground proposal would fail quality gates. It says the requested quality/cost comparison is not sufficiently identified with current host evidence.

## Fairness rules if revisited

- Clone both arms from one immutable public fixture hash; randomize or counterbalance order.
- Use identical read/write scope, visible/hidden gates, acceptance criteria and five-minute paired wall budget.
- Never write the Draft PR main workspace; do not call `router.apply`.
- Run hidden gates locally and never include them, the reference answer, or their output in model context.
- Record order effects, current-chat context contamination and self-review bias as remaining risks.
- Exact-hash user approval is not rework. Manual code edits, scope/provider/model/budget/egress changes, manual resend or gate skip are interventions and invalidate automatic success.
- A future host telemetry source must be independently authoritative before the arm can support a 30% cost claim.

## Consequence

S10a remains blocked even if the hybrid transport is technically ready. A later session may separately approve MCP registration and credential access for a bounded hybrid smoke, but it must not describe that one-arm run as a fair A/B cost result.
