---
name: codex-router
description: Use the repository's narrow Router tools when the user wants the current Codex GPT session to supervise a bounded background model execution without changing the Codex provider.
---

# Codex Router

Keep the current GPT session as supervisor. Use only `router.prepare`, `router.execute`, `router.status`, `router.abort`, `router.review_evidence`, `router.finalize`, `router.repair`, and `router.apply`; these tools call the shared Router core.

Prepare one minimal TaskPackage containing the goal, bounded scopes, acceptance criteria, stop conditions, privacy/egress fields, budget, and content-hash manifest. Never include full chat history, hidden reasoning, credentials, or unapproved file contents.

Call `router.prepare`, show its compact approval summary to the user, and call `router.execute` only after the user approves that exact `approval_summary_hash`. Poll `router.status` without retrying execution. When evidence is ready, call `router.review_evidence`, review the referenced diff and evidence against the TaskPackage, then call `router.finalize` with exactly `PASS`, `REPAIR_REQUIRED`, or `BLOCKED` bound to the current EvidenceBundle hash.

`PASS` only enters `APPLY_PENDING`; it never writes the main workspace. Use `REPAIR_REQUIRED` only for a concrete issue repairable under the unchanged TaskPackage, RouteBinding, provider/model, scope, budget, privacy/egress authorization, and approval. Call `router.repair` at most once with that same approval summary hash, then review the new attempt and EvidenceBundle. Call `router.apply` only as an explicit final action after PASS. Apply never commits, merges, pushes, or overwrites dirty targets.

Stop and report `BLOCKED` when the core reports a boundary failure or ambiguous attempt, evidence is incomplete, the main snapshot or target preimage changed, or completion would require different scope, provider, model, budget, data egress, privacy classification, or authorization. Do not reproduce policy, route, credential, filesystem, retry, or evidence validation in the skill. Do not modify MCP registration, Codex configuration, provider, authentication, or the main workspace outside the explicit `router.apply` action.
