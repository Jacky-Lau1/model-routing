# 27｜S10 preflight remediation and exact-approval handoff

> Status: **BLOCKED**. This document records offline/mock remediation only. S10/S10a did not run; no real provider, credential, Codex config, apply, commit, push, merge, or PR-state action was authorized or performed.

## What changed

Canonical accounting now separates one logical EXECUTE/REPAIR attempt from its potentially multiple billable HTTP rounds. Every observed round records request identity, timestamps, wall clock, response tuple, outcome/failure classification, complete usage/cache categories when available, provider-reported cost when supplied, versioned list estimate, catalog hash and UTC price band. EXECUTE and REPAIR aggregate without resetting prior attempt/request/token/wall/cost use.

`EvidenceBundle` v3 preserves four distinct cost layers:

- `provider_reported_usd`: null unless every billable round reports it;
- `estimated_list_usd`: cache- and time-band-aware sum from complete actual usage;
- `invoice_usd`: null until authoritative billing reconciliation exists;
- `chatgpt_quota`: null until the host exposes an authoritative value.

Zero is accepted only as an observed/calculated zero. Missing usage, unknown model, ambiguous time band, stale/tampered catalog or incomplete canonical price evidence fails closed. The catalog is also embedded in `RouteBinding`, so a catalog version/hash change invalidates the route approval before execution.

The runtime checks, before every canonical DeepSeek round, remaining attempt count, provider-request count, cumulative token limits, request/total wall limits and worst-case list estimate using the request output ceiling. It checks actual usage and list estimate again before processing returned tools or patches. AMBIGUOUS rounds remain non-retriable through durable attempt semantics; duplicate/concurrent execute uses the existing execution lock.

## Current official price snapshot

Retrieved at `2026-08-24T03:30:00Z`, catalog `2026-08-24.1`, SHA-256 `2266ac8fc7a6a89c4ec37c7a3f9d1bb5c885ad27ada72a04217b996d25b69e74`:

- DeepSeek Flash peak: cache hit `$0.014/M`, cache miss `$0.44/M`, output `$1.32/M`; off-peak is `$0.007/M`, `$0.22/M`, `$0.66/M`.
- DeepSeek Pro peak: `$0.044/M`, `$1.32/M`, `$3.96/M`; off-peak is `$0.022/M`, `$0.66/M`, `$1.98/M`.
- DeepSeek peak is weekday UTC `01:00–04:00` and `06:00–10:00`; other times use off-peak.
- GPT-5.6 Terra standard list rates are input `$2/M`, cached input `$0.20/M`, output `$12/M`.

Sources: <https://api-docs.deepseek.com/quick_start/pricing/>, <https://api-docs.deepseek.com/updates/>, <https://developers.openai.com/api/docs/models/gpt-5.6-terra>.

The catalog expires locally at `2026-09-23T03:30:00Z`; a later run must refresh and reapprove it. The system can prove enforcement against this approved catalog and observed response usage. It cannot prove invoice cost, a provider price change not yet reflected in the catalog, network peer/proxy identity, or an absolute monetary cap after a request has already been accepted. The pre-send input bound uses serialized request bytes plus a conservative framing margin; the provider does not publish a contractual tokenizer/framing upper-bound guarantee, so documentation must not call this an absolute currency guarantee.

## Pilot schema and decision gates

`config/pilot-report.schema.json` and `src/pilot-report.ts` define hash-bound run/pair records. They include the requested contract hashes, route tuple/auth alias, first-pass/final acceptance, visible/hidden tests, regression, repair and intervention taxonomy, violations/ambiguity, per-stage/model usage, provider HTTP count, stage wall clocks, four-layer costs, pricing evidence, risks and `expand|simplify|stop`.

Fixed hard stops are any secret/scope/privacy/routing violation, main-workspace pollution, unexplained duplicate request, AMBIGUOUS attempt/request or regression. Hybrid acceptance cannot be lower. Cost reduction below 30% cannot satisfy the original goal. Missing core GPT identity/token/request/cost evidence blocks expansion. See the separate GPT-only ADR for why the current pair recommendation is `stop` rather than a fabricated comparison.

## MCP registration: preview only

The official Codex MCP documentation permits STDIO servers under `mcp_servers` with fixed `command`, `args`, `cwd` and tool allowlisting; configuration changes require restart/new session: <https://developers.openai.com/codex/mcp/>.

The checked-in [config/codex-mcp-registration.s10a.toml.example](../config/codex-mcp-registration.s10a.toml.example), SHA-256 `88dc5347bb9d3514259f5e4f068e48c64f7cd5a382ed0d87be38ba1ff06e5b09`, is now a sanitized preview with generic paths. It is not an executable approval artifact; `buildMcpRegistrationPreview(...)` must generate the exact local block and hash in the authorized installation session. The preview:

- keeps the current Codex provider/model/auth untouched;
- illustrates the Node executable, TypeScript MCP entry, argv, repository cwd, external fixture/state roots and eight `router.*` tools without committing a user's local paths;
- contains no `env`, `env_vars`, provider profile, model setting or `auth.json` reference;
- starts the MCP process with a runtime environment allowlist and drops inherited credential-bearing variables;
- therefore cannot execute the proposed DPAPI route until a separate credential-path authorization is made.

Dry-run is `buildMcpRegistrationPreview(...)`: it returns only an exact TOML block and `+` diff preview and never writes config. Offline tests wrote the block only to a temporary Codex home, preserved synthetic `config.toml` and `auth.json` hashes, launched the STDIO process with a minimal synthetic environment, and discovered exactly eight tools through `initialize` + `tools/list`.

Next-session change procedure:

1. Verify the TOML template hash and preview the exact addition to the intended user or trusted-project `config.toml`.
2. Separately approve that exact config target and addition; do not touch `auth.json`, provider/model or profiles.
3. Provision the external fixture repo/state roots and verify all policy/template hashes.
4. Restart Codex or open a new session, then require actual discovery of all eight `router.*` tools.
5. If discovery fails, remove the exact block, restart, and remain BLOCKED.

Rollback is removal of only the exact hash-verified block followed by restart/new session. No real registration occurred in this stage, and the current GPT session still cannot discover `router.*`; that fact alone keeps status BLOCKED.

## Proposed S10a exact approval package (not authorized)

- TaskPackage: [examples/s10a-task-package.template.json](../examples/s10a-task-package.template.json), hash `202d276d07c233fc9561b15a01558d068f789147e61c55be7d2fe3162e85afc2`.
- RouteBinding: [examples/s10a-route-binding.template.json](../examples/s10a-route-binding.template.json), hash `2c3600fccf4d4fed24e680ff5211311a112ad35e6ff406ad326943f7976be3e6`.
- User policy: `e90da9c085824c306fc173966eaff50b30844bf5e7067242be6ac1217b14d034`.
- Project policy: `67e2da4a9d9d754cab75215202fbc9a722f531cafec98aa0399719515cf5ebb2`.
- Price catalog: `2026-08-24.1` / `2266ac8fc7a6a89c4ec37c7a3f9d1bb5c885ad27ada72a04217b996d25b69e74`.
- DeepSeek Flash only; no Pro escalation, no redirect; DPAPI is an alias only and no credential was read.
- Cumulative budget: 2 attempts (EXECUTE plus at most one REPAIR), 6 HTTP requests, 4,000 input tokens, 1,000 output tokens, 2 tool calls per attempt, 30-second request timeout, 300-second total, current-catalog worst-case list estimate `$0.00308`.
- Egress: only the three verified public fixture hashes; hidden tests/reference answer excluded.
- Write: only isolated fixture `src/sum.mjs`; never `router.apply` to the Draft PR workspace.

The next session's compact approval summary must show at least: task ID/hash, route hash, provider/adapter/model, endpoint/protocol, auth alias (not secret), reasoning mode/effort, pricing version/hash and validity, exact read/write/egress paths and content hashes, classification, attempts/request/token/tool/request-wall/total-wall/list-cost ceilings, external state/worktree roots, base commit/snapshot/isolation hash, hidden-data exclusion, no-redirect/no-escalation/no-apply constraints, approval summary hash and expiry.

## Offline verification

All transient state and emit output used a verified external root under `<external-temp-root>\codex-s10-preflight-<run-id>`, which was exact-path checked and removed afterward. The original machine-specific absolute path is intentionally not retained in the repository.

- bundled Node + TypeScript `tsc -p tsconfig.json --noEmit`: exit 0;
- `git diff --check`: exit 0 (existing LF/CRLF notices only);
- directed pricing/budget/contracts/Pilot/MCP/S8 set: 7 files, 90 tests passed;
- full suite: 27/27 files, 390/390 tests passed;
- S8: 6/6 passed;
- S9: 26/26 passed;
- external emit: exit 0, 186 files, then removed;
- temporary MCP: `initialize` and `tools/list` discovered exactly eight tools; synthetic config/auth hashes unchanged.

The pre-existing Draft PR dirty tree was retained. Final status adds only the intended S10 preflight sources, schemas, tests, templates and documents; no `dist`, coverage, test state, worktree or generated repository artifact appeared.

## Remaining blockers

1. The current GPT session has no actual `router.*` discovery because no real MCP registration was authorized.
2. No real credential path/read is authorized; the minimal MCP environment deliberately removes it.
3. Foreground GPT identity/request/token/cost/quota telemetry is unavailable, so the proposed two-arm cost comparison is not sufficiently fair.
4. Real provider behavior, invoice reconciliation, DNS/socket peer and proxy remain unverified.

Therefore the only valid state is **BLOCKED**, not `READY_FOR_EXACT_S10_APPROVAL`, until a new session separately resolves the applicable blockers.
