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
import type { EffectivePolicy, EvidenceBundle, ProjectPolicy, RouteBinding, TaskPackage, UserPolicy } from "../src/types.js";

const CONTENT_A = "a".repeat(64);
const CONTENT_B = "b".repeat(64);
const COMMIT = "1".repeat(40);
const SNAPSHOT = "2".repeat(64);
const NOW = new Date("2026-08-21T00:00:00.000Z");

const budget = {
  max_input_tokens: 4_000,
  max_output_tokens: 1_000,
  max_tool_calls: 2,
  max_wall_time_ms: 30_000,
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

function routeInput(overrides: Partial<RouteBindingInput> = {}): RouteBindingInput {
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
      completed_at: null, failure_class: "none", provider_request_id: null, response_model: null, response_origin: null, usage: null, redacted_error: null,
    } as const;
    expect(() => assertAttemptRecord(attempt)).not.toThrow();
    expect(() => assertAttemptRecord({ ...attempt, unknown: true })).toThrow(/unknown field/);

    const bundle = createEvidenceBundle({
      version: 1, bundle_id: "bundle-1", run_id: "synthetic-run", task_id: subject.taskPackage.task_id,
      task_package_hash: subject.taskPackage.task_package_hash, route_binding_hash: subject.routeBinding.route_binding_hash,
      policy_hash: subject.effectivePolicy.policy_hash, base_commit: COMMIT, worktree_head: COMMIT,
      attempt_ids: [attempt.attempt_id], route_evidence_ids: [], files_changed: ["src/a.ts"], diff_hash: "d".repeat(64),
      diff_reference: ".router-state/evidence/synthetic.diff", quality_gate_results: [], tests_run: [], scope_violations: [], privacy_violations: [],
      secret_scan_summary: { outcome: "passed", findings: 0 }, usage_metrics: { input_tokens: 0, output_tokens: 0, reasoning_tokens: 0 },
      cost_metrics: { provider_reported_usd: null, estimated_list_usd: null, invoice_usd: null, chatgpt_quota: null },
      wall_clock_time_ms: 0, repair_count: 0, remaining_risks: ["Synthetic S1 contract only"], redaction_notes: ["No real data"],
    });
    expect(() => assertEvidenceBundle(bundle)).not.toThrow();
    expect(bundle.bundle_hash).toMatch(/^[a-f0-9]{64}$/);
  });
});
