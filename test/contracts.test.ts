import { describe, expect, it } from "vitest";
import { approveContracts, assertContractApproval } from "../src/approval.js";
import {
  assertAttemptRecord,
  assertEvidenceBundle,
  assertTaskPackage,
  canonicalSerialize,
  createEvidenceBundle,
  createExecutionContext,
  createTaskPackage,
  normalizePrivacyInput,
  stableHash,
  type RouteBindingInput,
  type TaskPackageInput,
} from "../src/contracts.js";
import { buildRouteBinding, createProjectPolicy, createUserPolicy, resolveEffectivePolicy } from "../src/policy.js";
import { PRICING_CATALOG_HASH, PRICING_CATALOG_VERSION } from "../src/cost.js";
import type { EffectivePolicy, EvidenceBundle, ProjectPolicy, RouteBinding, TaskPackage, UserPolicy } from "../src/types.js";

const CONTENT_A = "a".repeat(64);
const CONTENT_B = "b".repeat(64);
const COMMIT = "1".repeat(40);
const SNAPSHOT = "2".repeat(64);
const NOW = new Date("2026-08-21T00:00:00.000Z");

const budget = {
  max_attempts: 2,
  max_provider_requests: 6,
  max_input_tokens: 4_000,
  max_output_tokens: 1_000,
  max_tool_calls: 2,
  max_request_wall_time_ms: 30_000,
  max_wall_time_ms: 300_000,
  max_estimated_cost_usd: 0.25,
  billing_mode: "prepaid" as const,
};

function taskInput(overrides: Partial<TaskPackageInput> = {}): TaskPackageInput {
  return {
    version: 1,
    task_id: "synthetic-task",
    goal: "Update a synthetic parser fixture.",
    background_summary: "Synthetic public fixture with no real configuration or credential data.",
    acceptance_criteria: ["Synthetic checks pass"],
    non_goals: ["No network calls"],
    forbidden_actions: ["Do not read outside the declared scope"],
    read_scope: ["src/a.ts", "src/b.ts"],
    write_scope: ["src/a.ts", "src/b.ts"],
    relevant_interfaces: ["parse(value: string): string"],
    context_manifest: [
      { path: "src/a.ts", kind: "file", selector: null, content_hash: CONTENT_A, source: "synthetic_fixture", byte_length: 32, summary: "Synthetic parser fixture." },
    ],
    validation_requirements: ["synthetic-typecheck"],
    stop_conditions: ["Requested scope changes"],
    data_classification: "public",
    egress_policy: {
      mode: "allow", providers: ["deepseek"], paths: ["src/a.ts", "src/b.ts"], content_hashes: [CONTENT_A, CONTENT_B],
      authorization_id: "synthetic-user-approval", authorized_by: "user", authorized_at: NOW.toISOString(), expires_at: null,
    },
    request_budget: budget,
    created_at: NOW.toISOString(),
    ...overrides,
  };
}

function policies(userEgress: UserPolicy["egress_policy"] = taskInput().egress_policy, projectEgress: ProjectPolicy["egress_policy"] = { mode: "allow", providers: ["deepseek"], paths: ["src/a.ts", "src/b.ts"], content_hashes: [CONTENT_A, CONTENT_B] }): { user: UserPolicy; project: ProjectPolicy; effective: EffectivePolicy } {
  const user = createUserPolicy({ version: 1, policy_id: "synthetic-user-policy", egress_policy: userEgress, read_scope: ["src/a.ts", "src/b.ts"], write_scope: ["src/a.ts", "src/b.ts"], budget_ceiling: budget });
  const project = createProjectPolicy({ version: 1, policy_id: "synthetic-project-policy", egress_policy: projectEgress, read_scope: ["src/a.ts", "src/b.ts"], write_scope: ["src/a.ts", "src/b.ts"], budget_ceiling: budget });
  return { user, project, effective: resolveEffectivePolicy(user, project) };
}

type RouteBindingDraft = Omit<RouteBindingInput, "pricing_catalog_version" | "pricing_catalog_hash">;
function routeInput(overrides: Partial<RouteBindingDraft> = {}): RouteBindingDraft {
  return {
    version: 1,
    provider_id: "deepseek",
    adapter_id: "deepseek-direct",
    model_id: "deepseek-v4-flash",
    endpoint_origin: "https://api.deepseek.com",
    endpoint_path: "/chat/completions",
    wire_protocol: "chat_completions",
    auth_alias: "synthetic-deepseek-alias",
    reasoning_mode: "disabled",
    reasoning_effort: "none",
    request_budget: budget,
    read_scope: ["src/a.ts"],
    write_scope: ["src/a.ts"],
    network_scope: ["https://api.deepseek.com"],
    environment_scope: [],
    command_scope: [],
    ...overrides,
  };
}

function context(task: TaskPackage, route: RouteBinding, policy: EffectivePolicy) {
  return createExecutionContext({
    version: 1, run_id: "synthetic-run", task_id: task.task_id, base_commit: COMMIT, main_workspace_snapshot: SNAPSHOT,
    main_workspace_dirty_evidence: [], worktree_id: "logical-worktree-not-created", worktree_base: COMMIT,
    policy_hash: policy.policy_hash, task_package_hash: task.task_package_hash, route_binding_hash: route.route_binding_hash, created_at: NOW.toISOString(),
  });
}

function approvedSubject(task = createTaskPackage(taskInput()), routeOverride: Partial<RouteBindingInput> = {}, effective = policies().effective) {
  const route = buildRouteBinding(routeInput(routeOverride), task, effective, NOW);
  return { taskPackage: task, routeBinding: route, effectivePolicy: effective, executionContext: context(task, route, effective) };
}

describe("canonical contract hashing", () => {
  it("does not depend on object field order", () => {
    const original = taskInput();
    const reversed = Object.fromEntries(Object.entries(original).reverse()) as unknown as TaskPackageInput;
    expect(createTaskPackage(original).task_package_hash).toBe(createTaskPackage(reversed).task_package_hash);
    expect(canonicalSerialize({ b: 2, a: 1 })).toBe(canonicalSerialize({ a: 1, b: 2 }));
  });

  it("deep-clones and freezes the canonical RouteBinding creation boundary", () => {
    const input = routeInput({ request_budget: { ...budget } }); const binding = buildRouteBinding(input, createTaskPackage(taskInput()), policies().effective, NOW);
    input.read_scope[0] = "src/b.ts"; input.request_budget.max_output_tokens = 9;
    expect(binding.read_scope).toEqual(["src/a.ts"]); expect(binding.request_budget.max_output_tokens).toBe(1_000);
    expect(Object.isFrozen(binding)).toBe(true); expect(Object.isFrozen(binding.request_budget)).toBe(true); expect(Object.isFrozen(binding.read_scope)).toBe(true);
    expect(() => { binding.write_scope.push("src/b.ts"); }).toThrow();
  });

  it("invalidates approval when route, scope, policy, or budget changes", () => {
    const base = approvedSubject();
    const approval = approveContracts(base, { approvalId: "synthetic-approval", approvedAt: NOW });
    expect(() => assertContractApproval(base, approval, NOW)).not.toThrow();

    const routeChanged = approvedSubject(base.taskPackage, { model_id: "deepseek-v4-pro" }, base.effectivePolicy);
    expect(() => assertContractApproval(routeChanged, approval, NOW)).toThrow(/invalidated/);

    const scopeChanged = approvedSubject(base.taskPackage, { read_scope: ["src/b.ts"], write_scope: ["src/b.ts"] }, base.effectivePolicy);
    expect(() => assertContractApproval(scopeChanged, approval, NOW)).toThrow(/invalidated/);

    const budgetChanged = approvedSubject(base.taskPackage, { request_budget: { ...budget, max_output_tokens: 999 } }, base.effectivePolicy);
    expect(() => assertContractApproval(budgetChanged, approval, NOW)).toThrow(/invalidated/);

    const { route_binding_hash: _routeHash, ...routeBody } = base.routeBinding;
    const repricedBody = { ...routeBody, pricing_catalog_version: "synthetic-next-catalog", pricing_catalog_hash: "f".repeat(64) };
    const repricedRoute = { ...repricedBody, route_binding_hash: stableHash(repricedBody) } as RouteBinding;
    expect(() => assertContractApproval({ ...base, routeBinding: repricedRoute }, approval, NOW)).toThrow(/pricing catalog.*approval/i);

    const { user, project } = policies();
    const { policy_hash: _projectHash, ...projectBody } = project;
    const changedProject = createProjectPolicy({ ...projectBody, policy_id: "synthetic-project-policy-v2" });
    const policyChanged = approvedSubject(base.taskPackage, {}, resolveEffectivePolicy(user, changedProject));
    expect(() => assertContractApproval(policyChanged, approval, NOW)).toThrow(/invalidated/);
  });
});

describe("privacy and policy contraction", () => {
  it("normalizes convenience privacy input into two auditable dimensions", () => {
    const egress = taskInput().egress_policy;
    expect(normalizePrivacyInput("PRIVATE_THIRD_PARTY_ALLOWED", egress)).toEqual({ data_classification: "private", egress_policy: egress });
    expect(normalizePrivacyInput(undefined)).toEqual({ data_classification: null, egress_policy: { mode: "deny" } });
  });

  it("denies DeepSeek for private data without explicit egress authorization", () => {
    const task = createTaskPackage(taskInput({ data_classification: "private", egress_policy: { mode: "deny" } }));
    const effective = policies({ mode: "deny" }, { mode: "allow", providers: ["deepseek"], paths: ["src/a.ts"], content_hashes: [CONTENT_A] }).effective;
    expect(effective.egress_policy).toEqual({ mode: "deny" });
    expect(() => buildRouteBinding(routeInput(), task, effective, NOW)).toThrow(/Explicit user egress authorization/);
  });

  it("denies DeepSeek for public data when egress was not explicitly authorized", () => {
    const task = createTaskPackage(taskInput({ data_classification: "public", egress_policy: { mode: "deny" } }));
    const effective = policies({ mode: "deny" }, { mode: "allow", providers: ["deepseek"], paths: ["src/a.ts"], content_hashes: [CONTENT_A] }).effective;
    expect(() => buildRouteBinding(routeInput(), task, effective, NOW)).toThrow(/Explicit user egress authorization/);
  });

  it("denies an unclassified package before creating a DeepSeek binding", () => {
    const raw = { ...createTaskPackage(taskInput()) } as Record<string, unknown>;
    delete raw.data_classification;
    expect(() => buildRouteBinding(routeInput(), raw as unknown as TaskPackage, policies().effective, NOW)).toThrow(/missing field|data_classification|Unclassified/);
  });

  it("allows project policy to narrow but never override a user deny", () => {
    const denied = policies({ mode: "deny" }, { mode: "allow", providers: ["deepseek"], paths: ["src/a.ts"], content_hashes: [CONTENT_A] }).effective;
    expect(denied.egress_policy).toEqual({ mode: "deny" });
    const user = createUserPolicy({ version: 1, policy_id: "narrow-user", egress_policy: { mode: "deny" }, read_scope: ["src/a.ts"], write_scope: ["src/a.ts"], budget_ceiling: budget });
    const widenedProject = createProjectPolicy({ version: 1, policy_id: "wide-project", egress_policy: { mode: "deny" }, read_scope: ["src/b.ts"], write_scope: ["src/b.ts"], budget_ceiling: budget });
    expect(() => resolveEffectivePolicy(user, widenedProject)).toThrow(/cannot widen/);
  });

  it("fails closed when a wildcard subset cannot be proven conservatively", () => {
    const user = createUserPolicy({ version: 1, policy_id: "glob-user", egress_policy: { mode: "deny" }, read_scope: ["src/*"], write_scope: ["src/*"], budget_ceiling: budget });
    const project = createProjectPolicy({ version: 1, policy_id: "glob-project", egress_policy: { mode: "deny" }, read_scope: ["src/**"], write_scope: ["src/**"], budget_ceiling: budget });
    expect(() => resolveEffectivePolicy(user, project)).toThrow(/cannot widen/);
  });
});

describe("strict schema-equivalent validation", () => {
  it("rejects unknown fields, empty scope, dangerous absolute paths, and secret-like context", () => {
    expect(() => createTaskPackage({ ...taskInput(), unexpected: true } as never)).toThrow(/unknown field/);
    expect(() => createTaskPackage(taskInput({ read_scope: [] }))).toThrow(/non-empty scope/);
    expect(() => createTaskPackage(taskInput({ read_scope: ["C:/Users/example/private.ts"] }))).toThrow(/relative path/);
    const secretContext = taskInput();
    secretContext.context_manifest = [{ ...secretContext.context_manifest[0], summary: "api_key=synthetic-secret-value" }];
    expect(() => createTaskPackage(secretContext)).toThrow(/secret-like context/);
  });

  it("strictly validates all six separated cross-component records", () => {
    const subject = approvedSubject();
    const approval = approveContracts(subject, { approvalId: "record-approval", approvedAt: NOW });
    assertTaskPackage(subject.taskPackage);
    expect(() => assertContractApproval(subject, approval, NOW)).not.toThrow();
    const attempt = {
      version: 1, attempt_id: "attempt-1", run_id: "synthetic-run", stage: "EXECUTE", round: 0,
      request_fingerprint: stableHash({ synthetic: true }), status: "PREPARED", prepared_at: NOW.toISOString(), send_started_at: null,
      completed_at: null, failure_class: "none", provider_request_id: null, response_model: null, response_origin: null, usage: null, transport_rounds: [], provider_reported_cost_usd: null, estimated_list_cost_usd: null, redacted_error: null,
    } as const;
    expect(() => assertAttemptRecord(attempt)).not.toThrow();
    expect(() => assertAttemptRecord({ ...attempt, unknown: true })).toThrow(/unknown field/);

    const qualityPolicyBody = { version: 1 as const, policy_id: "synthetic-quality", command_ids: [], command_registry_hash: stableHash([]), max_diff_bytes: 1024, max_file_bytes: 1024, max_output_bytes: 1024, max_wall_time_ms: 300_000 };
    const qualityPolicy = { ...qualityPolicyBody, policy_hash: stableHash(qualityPolicyBody) };
    const gates = ["base_identity", "preapply_scope", "changed_files_scope", "forbidden_paths", "secret_scan", "diff_sanity", "format_check", "lint", "typecheck", "unit_tests", "build", "project_acceptance", "final_freeze", "evidence_artifact", "gate_budget"].map(gate_id => ({ gate_id, outcome: (["format_check", "lint", "typecheck", "unit_tests", "build", "project_acceptance"].includes(gate_id) ? "not_applicable" : "passed") as "passed" | "not_applicable", evidence_hash: stableHash({ gate_id }), summary: "synthetic" }));
    const fixtureHash = "e".repeat(64); const boundaryHash = "f".repeat(64);
    const qualityRequest = { run_id: "synthetic-run", task_id: subject.taskPackage.task_id, base_commit: COMMIT, plan_hash: subject.taskPackage.task_package_hash, approval_hash: "4".repeat(64), isolation_hash: "6".repeat(64), worktree_id: "synthetic-worktree", write_scope: ["src/a.ts"], command_ids: [], policy_hash: qualityPolicy.policy_hash, catalog_hash: qualityPolicy.command_registry_hash, fixture_hash: fixtureHash, hidden_root_hash: null, effective_policy_hash: subject.effectivePolicy.policy_hash, max_wall_time_ms: qualityPolicy.max_wall_time_ms };
    const qualityRequestHash = stableHash(qualityRequest);
    const qualityReport = { version: 1, run_id: qualityRequest.run_id, task_id: qualityRequest.task_id, base_commit: COMMIT, plan_hash: qualityRequest.plan_hash, approval_hash: qualityRequest.approval_hash, isolation_hash: qualityRequest.isolation_hash, worktree_id: qualityRequest.worktree_id, policy_hash: qualityRequest.policy_hash, approval_boundary_hash: boundaryHash, catalog_hash: qualityRequest.catalog_hash, fixture_hash: fixtureHash, hidden_root_hash: null, effective_policy_hash: qualityRequest.effective_policy_hash, max_wall_time_ms: qualityPolicy.max_wall_time_ms, request_hash: qualityRequestHash, passed: true, worktree_head: COMMIT, files_changed: ["src/a.ts"], content_snapshot_hash: "7".repeat(64), post_artifact_snapshot_hash: "7".repeat(64), worktree_snapshot_hash: "b".repeat(64), diff_hash: "d".repeat(64), diff_reference: `evidence/synthetic-run/${"d".repeat(64)}.diff`, quality_gate_results: gates, tests_run: [], scope_violations: [], privacy_violations: [], secret_scan_summary: { outcome: "passed", findings: 0, baseline_findings: 0, new_findings: 0 }, wall_clock_time_ms: 0, redaction_notes: ["No real data"], hidden_acceptance_result: null };
    const acceptanceBody = { version: 1 as const, approval_boundary_hash: boundaryHash, quality_report_hash: stableHash(qualityReport), fixture_hash: fixtureHash, base_commit: COMMIT, visible_tests: { passed: 0, failed: 0, not_run: 0 }, hidden_tests: { passed: 0, failed: 0, not_run: 1 }, regression: true, scope_passed: true, secret_passed: true, diff_passed: true, freeze_passed: true };
    const bundle = createEvidenceBundle({
      version: 4, bundle_id: "bundle-1", run_id: "synthetic-run", task_id: subject.taskPackage.task_id, contract_provenance: "canonical",
      task_package_hash: subject.taskPackage.task_package_hash, route_binding_hash: subject.routeBinding.route_binding_hash,
      policy_hash: subject.effectivePolicy.policy_hash, quality_policy_hash: qualityPolicy.policy_hash, quality_approval_boundary_hash: boundaryHash, quality_catalog_hash: qualityPolicy.command_registry_hash, fixture_hash: fixtureHash, hidden_root_hash: null, acceptance_results: { ...acceptanceBody, result_hash: stableHash(acceptanceBody) }, hidden_acceptance_result: null, quality_policy: qualityPolicy, approval_hash: "4".repeat(64), execution_context_hash: "5".repeat(64), isolation_hash: "6".repeat(64), worktree_id: "synthetic-worktree", base_commit: COMMIT, worktree_head: COMMIT,
      quality_request_hash: qualityRequestHash, quality_report_hash: stableHash(qualityReport), quality_passed: true, quality_write_scope: ["src/a.ts"], quality_command_ids: [], post_artifact_snapshot_hash: "7".repeat(64), worktree_snapshot_hash: "b".repeat(64),
      attempt_ids: [attempt.attempt_id], route_evidence_ids: [], attempt_summaries: [{ attempt_id: attempt.attempt_id, stage: "EXECUTE", status: "PREPARED", failure_class: "none" }], route_evidence_summaries: [], files_changed: ["src/a.ts"], content_snapshot_hash: "7".repeat(64), diff_hash: "d".repeat(64),
      transport_rounds: [],
      diff_reference: `evidence/synthetic-run/${"d".repeat(64)}.diff`, quality_gate_results: gates, tests_run: [], scope_violations: [], privacy_violations: [],
      secret_scan_summary: { outcome: "passed", findings: 0, baseline_findings: 0, new_findings: 0 }, usage_metrics: { input_tokens: 0, output_tokens: 0, reasoning_tokens: 0, cached_input_tokens: 0, cache_write_tokens: 0, cache_hit_tokens: 0, cache_miss_tokens: 0 },
      cost_metrics: { provider_reported_usd: null, estimated_list_usd: null, invoice_usd: null, chatgpt_quota: null },
      pricing_catalog: null, wall_clock_time_ms: 0, stage_wall_clock_ms: { plan: null, execute: 0, gate: 0, review: null, repair: 0, total: 0 }, repair_count: 0, remaining_risks: ["Synthetic S1 contract only"], redaction_notes: ["No real data"],
    });
    expect(() => assertEvidenceBundle(bundle)).not.toThrow();
    expect(bundle.bundle_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.isFrozen(bundle)).toBe(true); expect(Object.isFrozen(bundle.files_changed)).toBe(true); expect(Object.isFrozen(bundle.secret_scan_summary)).toBe(true);
    expect(() => bundle.files_changed.push("src/b.ts")).toThrow();
    const { bundle_hash: _bundleHash, ...bundleBody } = bundle;
    const unavailableUsage = createEvidenceBundle({ ...bundleBody, usage_metrics: { input_tokens: null, output_tokens: null, reasoning_tokens: null, cached_input_tokens: null, cache_write_tokens: null, cache_hit_tokens: null, cache_miss_tokens: null } });
    expect(bundle.usage_metrics.input_tokens).toBe(0); expect(unavailableUsage.usage_metrics.input_tokens).toBeNull();
    const pricedRound = { round_id: "round-contract-1", sequence: 0, stage: "EXECUTE" as const, request_id: "synthetic-request", started_at: "2026-08-24T07:00:00.000Z", completed_at: "2026-08-24T07:00:00.010Z", wall_clock_time_ms: 10, response_model: "deepseek-v4-flash", response_origin: "https://api.deepseek.com", response_path: "/chat/completions", http_status: 200, outcome: "SUCCEEDED" as const, failure_class: null, usage: { input_tokens: 1, output_tokens: 1, reasoning_tokens: 0, cached_input_tokens: 0, cache_write_tokens: 0, cache_hit_tokens: 0, cache_miss_tokens: 1 }, cache_status: "miss" as const, provider_reported_cost_usd: null, estimated_list_cost_usd: 0.00000176, pricing_catalog_version: PRICING_CATALOG_VERSION, pricing_catalog_hash: PRICING_CATALOG_HASH, pricing_time_band: "peak" as const };
    const priced = createEvidenceBundle({ ...bundleBody, attempt_summaries: [{ attempt_id: attempt.attempt_id, stage: "EXECUTE", status: "SUCCEEDED", failure_class: "none" }], transport_rounds: [pricedRound], usage_metrics: { ...bundleBody.usage_metrics, input_tokens: 1, output_tokens: 1, reasoning_tokens: 0, cached_input_tokens: 0, cache_write_tokens: 0, cache_hit_tokens: 0, cache_miss_tokens: 1 }, cost_metrics: { ...bundleBody.cost_metrics, estimated_list_usd: 0.00000176 }, pricing_catalog: { version: PRICING_CATALOG_VERSION, hash: PRICING_CATALOG_HASH, currency: "USD", source_urls: ["https://api-docs.deepseek.com/quick_start/pricing/"], retrieved_at: "2026-08-24T03:30:00.000Z", effective_at: "2026-08-16T16:00:00.000Z", time_bands: ["peak"] }, stage_wall_clock_ms: { ...bundleBody.stage_wall_clock_ms, execute: 10, total: 10 } });
    expect(priced.cost_metrics.provider_reported_usd).toBeNull(); expect(priced.cost_metrics.estimated_list_usd).toBe(0.00000176);
    const { bundle_hash: _pricedHash, ...pricedBody } = priced;
    expect(() => createEvidenceBundle({ ...pricedBody, cost_metrics: { ...priced.cost_metrics, estimated_list_usd: 0.00000177 } })).toThrow(/list cost/);
    expect(() => createEvidenceBundle({ ...pricedBody, pricing_catalog: { ...priced.pricing_catalog!, hash: "f".repeat(64) } })).toThrow(/pricing catalog/);
    expect(() => createEvidenceBundle({ ...bundleBody, quality_gate_results: [] })).toThrow(/sequence/);
    expect(() => createEvidenceBundle({ ...bundleBody, quality_report_hash: "f".repeat(64) })).toThrow(/report hash|acceptance results/);
    expect(() => createEvidenceBundle({ ...bundleBody, quality_passed: false })).toThrow(/quality_passed/);
    expect(() => createEvidenceBundle({ ...bundleBody, files_changed: ["outside.ts"] })).toThrow(/write scope/);
    expect(() => createEvidenceBundle({ ...bundleBody, post_artifact_snapshot_hash: "a".repeat(64) })).toThrow(/artifact gate/);
    expect(() => createEvidenceBundle({ ...bundleBody, wall_clock_time_ms: qualityPolicy.max_wall_time_ms, stage_wall_clock_ms: { ...bundleBody.stage_wall_clock_ms, gate: qualityPolicy.max_wall_time_ms, total: qualityPolicy.max_wall_time_ms } })).toThrow(/gate_budget/);
    const otherHead = "2".repeat(40); expect(() => createEvidenceBundle({ ...bundleBody, worktree_head: otherHead, quality_report_hash: stableHash({ ...qualityReport, worktree_head: otherHead }) })).toThrow(/worktree or artifact|acceptance results/);
    const otherReference = "evidence/other-run/synthetic.diff"; expect(() => createEvidenceBundle({ ...bundleBody, diff_reference: otherReference, quality_report_hash: stableHash({ ...qualityReport, diff_reference: otherReference }) })).toThrow(/worktree or artifact|acceptance results/);
    const forbiddenRequest = { ...qualityRequest, write_scope: [".env"] }; const forbiddenRequestHash = stableHash(forbiddenRequest); const forbiddenReport = { ...qualityReport, request_hash: forbiddenRequestHash, files_changed: [".env"] };
    expect(() => createEvidenceBundle({ ...bundleBody, quality_write_scope: [".env"], files_changed: [".env"], quality_request_hash: forbiddenRequestHash, quality_report_hash: stableHash(forbiddenReport) })).toThrow(/forbidden-path|acceptance results/);
    expect(() => assertEvidenceBundle({ ...bundle, quality_gate_results: [
      { gate_id: "scope", outcome: "passed", evidence_hash: "8".repeat(64), summary: "synthetic" },
      { gate_id: "scope", outcome: "passed", evidence_hash: "8".repeat(64), summary: "synthetic" },
    ] })).toThrow(/duplicates/);
  });
});
