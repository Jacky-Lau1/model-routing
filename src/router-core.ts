import path from "node:path";
import { realpath } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { approveContracts, assertContractApproval } from "./approval.js";
import { DurableAttemptExecutor, ExecutionBusyError, type AttemptExecutionRequest } from "./attempt-executor.js";
import { AttemptPersistence } from "./attempt-persistence.js";
import { hashesEqual, stableHash } from "./canonical.js";
import { PRICING_CATALOG, assertPricingCatalog, pricingCatalogEvidence } from "./cost.js";
import {
  assertApprovalRecord, assertEvidenceBundle, assertExecutionContext, assertRouteBinding, assertSafeRelativePath, assertTaskPackage, containsSecretLikeText,
  createEvidenceBundle, createExecutionContext, createTaskPackage, type RouteBindingInput, type TaskPackageInput,
} from "./contracts.js";
import { buildPrompt } from "./context.js";
import { assertEffectivePolicy, buildRouteBinding, resolveEffectivePolicy } from "./policy.js";
import { assertProviderRouteEvidence, providerRequestFingerprint } from "./provider-evidence.js";
import {
  DEFAULT_QUALITY_GATE_POLICY, assertQualityGatePolicy, assertQualityGateReportForRequest,
  persistEvidenceBundle, readEvidenceArtifact,
} from "./quality-gate.js";
import {
  assertPilotQualityGate, assertQualityGateApprovalBoundary, assertQualityGateRuntimeBinding, createQualityGateApprovalBoundary,
  type QualityGateApprovalBoundary, type TrustedQualityCommandCatalog,
} from "./quality-gate-config.js";
import { createQualityAcceptanceProjection, hashHiddenAcceptanceRoot, hashQualityFixtureRoot } from "./hidden-acceptance.js";
import { createPilotRunRecordFromEvidence, persistPilotRunRecord, readPilotRunRecord } from "./pilot-report.js";
import { redactError } from "./redaction.js";
import { adapterIdFor, freezeRouteBinding, preflightRouteBinding } from "./route-preflight.js";
import { RouterCoreStore } from "./router-core-store.js";
import { applyStructuredPatches, buildExecutorCapabilityGrant, DEFAULT_EXECUTOR_FILE_LIMIT, SafeExecutor } from "./safe-executor.js";
import { snapshotWorkingTree, hashScopeSnapshot } from "./scope-guard.js";
import { GitWorktreeManager, type WorktreeBinding, type WorktreeLease } from "./worktree.js";
import type {
  ApprovalRecord, EffectivePolicy, EvidenceBundle, ExecutionContext, ExecutorCapabilityGrant, ProjectPolicy, ProviderAdapter, ProviderRequest,
  PilotRunRecord, ProviderBudgetState, ProviderResponse, QualityAcceptanceProjection, QualityGatePolicy, QualityGateReport, QualityGateRequest, RequestBudget, RouteBinding, RouteDecision, TaskPackage,
  UserPolicy, WorkflowState,
} from "./types.js";

const HASH = /^[a-f0-9]{64}$/;

export interface RouterRouteProfile extends Omit<RouteBindingInput, "read_scope" | "write_scope" | "request_budget" | "pricing_catalog_version" | "pricing_catalog_hash"> {
  request_budget?: RequestBudget;
}

export interface RouterCoreConfig {
  project_directory: string;
  state_root: string;
  evidence_root?: string;
  fixture_root?: string;
  hidden_root?: string | null;
  approval_ttl_ms?: number;
  user_policy: UserPolicy;
  project_policy: ProjectPolicy;
  route_profile: RouterRouteProfile;
}

export interface RouterCoreDependencies {
  model_adapter: ProviderAdapter;
  local_adapter: ProviderAdapter;
  quality_policy?: QualityGatePolicy;
  quality_catalog?: TrustedQualityCommandCatalog;
  attempts?: DurableAttemptExecutor;
  worktrees?: GitWorktreeManager;
  now?: () => Date;
}

export interface RouterApprovalSummary {
  task_id: string;
  goal: string;
  provider: string;
  model: string;
  data_classification: TaskPackage["data_classification"];
  read_scope: string[];
  write_scope: string[];
  budget: RequestBudget;
  task_package_hash: string;
  route_binding_hash: string;
  execution_context_hash: string;
  policy_hash: string;
  adapter_id: string;
  endpoint_origin: string;
  endpoint_path: string;
  wire_protocol: RouteBinding["wire_protocol"];
  auth_alias: string | null;
  reasoning_mode: RouteBinding["reasoning_mode"];
  reasoning_effort: RouteBinding["reasoning_effort"];
  pricing: {
    version: string | null;
    hash: string | null;
    retrieved_at: string;
    valid_at: string;
    valid_until: string;
  };
  egress_policy: TaskPackage["egress_policy"];
  quality: {
    policy_hash: string;
    command_catalog_hash: string;
    command_ids: string[];
    approval_boundary_hash: string | null;
    fixture_hash: string;
    hidden_root_hash: string | null;
    commands: QualityGateApprovalBoundary["commands"];
    max_output_bytes: number;
    max_wall_time_ms: number;
  };
  roots: {
    project: string;
    state: string;
    worktree: string;
    evidence: string;
    fixture: string;
    hidden: string | null;
  };
  isolation: {
    base_commit: string;
    main_workspace_snapshot: string;
    isolation_hash: string;
  };
  hidden_data: {
    model_context_excluded: true;
    egress_excluded: true;
    result_mode: "bounded_redacted_only";
  };
  restrictions: {
    redirect: "forbidden";
    escalation: "forbidden";
    automatic_retry: "forbidden";
    apply: "separate_explicit_action";
    commit: "forbidden";
    push: "forbidden";
  };
  stop_conditions: string[];
  approval_expires_at: string;
  approval_summary_hash: string;
}

export interface RouterCompactStatus {
  task_id: string;
  state: WorkflowState;
  approval_summary: RouterApprovalSummary;
  approved: boolean;
  attempts: Array<{ attempt_id: string; stage: string; status: string; failure_class: string }>;
  blocked_reason: string | null;
  evidence_bundle: { bundle_hash: string; reference: string; quality_passed: boolean } | null;
  final_review: { decision: FinalReviewDecision; summary: string; reviewed_at: string } | null;
  repair_count: number;
  applied: boolean;
  next: "execute" | "status" | "review_evidence" | "repair" | "apply" | "none";
}

export type FinalReviewDecision = "PASS" | "REPAIR_REQUIRED" | "BLOCKED";

export interface RouterReviewEvidence {
  task_id: string;
  state: WorkflowState;
  evidence_bundle_hash: string;
  evidence_bundle_reference: string;
  quality_passed: boolean;
  files_changed: string[];
  quality_gate_results: EvidenceBundle["quality_gate_results"];
  tests_run: EvidenceBundle["tests_run"];
  route_evidence_summaries: EvidenceBundle["route_evidence_summaries"];
  scope_violations: string[];
  privacy_violations: string[];
  remaining_risks: string[];
  diff_reference: string;
  diff_hash: string;
}

interface CoreExecutionEvidence {
  attempt_id: string;
  provider_request_id: string;
  response_model: string;
  response_origin: string;
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
}

interface ApplyTarget {
  path: string;
  preimage_hash: string | null;
  postimage_hash: string;
  replacement: string;
}

interface CoreRecord {
  version: 1;
  task_package: TaskPackage;
  effective_policy: EffectivePolicy;
  route_binding: RouteBinding;
  execution_context: ExecutionContext;
  worktree_binding: WorktreeBinding;
  approval_record: ApprovalRecord | null;
  execution_evidence: CoreExecutionEvidence | null;
  evidence_bundle_hash: string | null;
  evidence_bundle_reference: string | null;
  quality_summary: { quality_passed: boolean; files_changed: string[]; gate_failures: string[] } | null;
  final_review: { decision: FinalReviewDecision; summary: string; reviewed_at: string; evidence_bundle_hash: string } | null;
  review_history: Array<{ decision: FinalReviewDecision; summary: string; reviewed_at: string; evidence_bundle_hash: string }>;
  repair_count: number;
  apply_record: {
    status: "PREPARED" | "APPLIED";
    evidence_bundle_hash: string;
    diff_hash: string;
    targets: Array<{ path: string; preimage_hash: string | null; postimage_hash: string }>;
    prepared_at: string;
    applied_at: string | null;
  } | null;
  quality_boundary: QualityGateApprovalBoundary | null;
  fixture_hash: string;
  hidden_root_hash: string | null;
  pilot_record_hash: string | null;
  pilot_record_reference: string | null;
  created_at: string;
  updated_at: string;
}

/** Deterministic S7 core used unchanged by the CLI and STDIO MCP transports. */
export class RouterCoreService {
  readonly store: RouterCoreStore;
  private readonly attempts: DurableAttemptExecutor;
  private readonly worktrees: GitWorktreeManager;
  private readonly effectivePolicy: EffectivePolicy;
  private readonly qualityPolicy: QualityGatePolicy;
  private readonly projectDirectory: string;
  private readonly routeProfile: RouterRouteProfile;
  private readonly now: () => Date;
  private readonly evidenceRoot: string;
  private readonly fixtureRoot: string;
  private readonly hiddenRoot: string | null;
  private readonly approvalTtlMs: number;
  private readonly qualityCatalog?: TrustedQualityCommandCatalog;
  private readonly realPilot: boolean;

  constructor(config: RouterCoreConfig, private readonly dependencies: RouterCoreDependencies) {
    this.projectDirectory = path.resolve(config.project_directory);
    this.routeProfile = structuredClone(config.route_profile);
    this.store = new RouterCoreStore(config.state_root);
    this.effectivePolicy = resolveEffectivePolicy(config.user_policy, config.project_policy);
    this.qualityPolicy = dependencies.quality_policy ?? DEFAULT_QUALITY_GATE_POLICY;
    assertQualityGatePolicy(this.qualityPolicy);
    this.attempts = dependencies.attempts ?? new DurableAttemptExecutor(new AttemptPersistence(this.store.root));
    this.worktrees = dependencies.worktrees ?? new GitWorktreeManager({ stateRoot: this.store.root });
    this.now = dependencies.now ?? (() => new Date());
    this.evidenceRoot = path.resolve(config.evidence_root ?? config.state_root);
    this.fixtureRoot = path.resolve(config.fixture_root ?? config.project_directory);
    this.hiddenRoot = config.hidden_root === null || config.hidden_root === undefined ? null : path.resolve(config.hidden_root);
    this.approvalTtlMs = config.approval_ttl_ms ?? 15 * 60_000;
    this.qualityCatalog = dependencies.quality_catalog;
    if ((config.fixture_root !== undefined) !== (config.hidden_root !== undefined && config.hidden_root !== null)) throw new Error("Pilot fixture_root and hidden_root must be configured together");
    this.realPilot = config.fixture_root !== undefined && config.hidden_root !== undefined && config.hidden_root !== null;
    if (!Number.isInteger(this.approvalTtlMs) || this.approvalTtlMs < 1_000 || this.approvalTtlMs > 24 * 60 * 60_000) throw new Error("Router approval TTL is invalid");
  }

  async prepare(input: TaskPackage | TaskPackageInput): Promise<RouterCompactStatus> {
    const task = normalizeTaskPackage(input);
    const preApprovalHash = preApprovalHashFor(task);
    await this.worktrees.assertIsolationRoots(this.projectDirectory);
    if (this.realPilot) await this.assertPilotRootIsolation();
    const release = await this.attempts.tryAcquireWorktreeHandoffLock(task.task_id, preApprovalHash);
    if (!release) return this.waitForStatus(task.task_id);
    try {
      const existing = await this.tryLoadRecord(task.task_id);
      if (existing) {
        if (!hashesEqual(existing.task_package.task_package_hash, task.task_package_hash)) throw new Error("Task id is already bound to a different TaskPackage");
        const durable = await this.attempts.status(task.task_id);
        if (!durable.workflow) {
          if (existing.approval_record || existing.execution_evidence || existing.evidence_bundle_hash || existing.final_review) throw new Error("Advanced Router state is missing its workflow checkpoint");
          await this.attempts.initializeAwaitingApproval(task.task_id, existing.execution_context.run_id, preApprovalHash);
        }
        return this.status(task.task_id);
      }
      if (this.routeProfile.provider_id !== "deepseek") throw new Error("S7 canonical execution supports only the bound Direct DeepSeek adapter");
      assertPricingCatalog(PRICING_CATALOG, this.now());
      const routeBinding = freezeRouteBinding(buildRouteBinding({
        ...this.routeProfile,
        request_budget: this.routeProfile.request_budget ?? task.request_budget,
        read_scope: [...task.read_scope],
        write_scope: [...task.write_scope],
      }, task, this.effectivePolicy, this.now()));
      const route = routeDecision(routeBinding, "EXECUTE");
      preflightRouteBinding(routeBinding, route, adapterIdFor(route.provider), "canonical");
      const baseline = await this.worktrees.captureMainWorkspace(this.projectDirectory);
      const runId = runIdFor(task);
      const worktreeBinding = this.worktrees.createBinding(runId, task.task_package_hash, baseline);
      const createdAt = this.now().toISOString();
      const executionContext = createExecutionContext({
        version: 1, run_id: runId, task_id: task.task_id, base_commit: baseline.base_commit,
        main_workspace_snapshot: baseline.main_workspace_snapshot,
        main_workspace_dirty_evidence: baseline.main_workspace_dirty_evidence,
        worktree_id: worktreeBinding.worktree_id, worktree_base: worktreeBinding.base_commit,
        policy_hash: this.effectivePolicy.policy_hash, task_package_hash: task.task_package_hash,
        route_binding_hash: routeBinding.route_binding_hash, created_at: createdAt,
      });
      if (this.realPilot) {
        if (!this.qualityCatalog || !this.hiddenRoot) throw new Error("Real Pilot runtime requires explicit fixture/hidden roots and a trusted quality catalog");
        assertPilotQualityGate(this.qualityPolicy, this.qualityCatalog);
      }
      const fixtureHash = this.realPilot ? await hashQualityFixtureRoot(this.fixtureRoot) : stableHash({ context_manifest: task.context_manifest });
      const hiddenRootHash = this.hiddenRoot ? await hashHiddenAcceptanceRoot(this.hiddenRoot) : null;
      const provisional = approveContracts({ taskPackage: task, routeBinding, executionContext, effectivePolicy: this.effectivePolicy }, {
        approvalId: approvalIdFor(task.task_id, executionContext.execution_context_hash), approvedAt: new Date(createdAt),
        expiresAt: new Date(Date.parse(createdAt) + this.approvalTtlMs),
      });
      const qualityRequest = qualityGateRequestFor(task, routeBinding, executionContext, worktreeBinding, this.qualityPolicy, this.qualityCatalog?.catalog_hash ?? this.qualityPolicy.command_registry_hash, fixtureHash, hiddenRootHash, provisional.approval_hash);
      const qualityBoundary = this.qualityCatalog ? createQualityGateApprovalBoundary({
        request: qualityRequest, policy: this.qualityPolicy, catalog: this.qualityCatalog, fixtureHash, hiddenRootHash,
        worktreeRoot: path.join(this.worktrees.managedRoot, worktreeBinding.worktree_id, "checkout"), evidenceRoot: this.evidenceRoot, realPilot: this.realPilot,
      }) : null;
      const record: CoreRecord = {
        version: 1, task_package: task, effective_policy: this.effectivePolicy, route_binding: routeBinding,
        execution_context: executionContext, worktree_binding: worktreeBinding, approval_record: null,
        execution_evidence: null, evidence_bundle_hash: null, evidence_bundle_reference: null,
        quality_summary: null, final_review: null, review_history: [], repair_count: 0, apply_record: null,
        quality_boundary: qualityBoundary, fixture_hash: fixtureHash, hidden_root_hash: hiddenRootHash,
        pilot_record_hash: null, pilot_record_reference: null,
        created_at: createdAt, updated_at: createdAt,
      };
      assertCoreRecord(record);
      await this.attempts.initializeAwaitingApproval(task.task_id, runId, preApprovalHash);
      await this.store.save(task.task_id, record);
      return this.status(task.task_id);
    } finally { await release(); }
  }

  async execute(taskId: string, approvalSummaryHash: string): Promise<RouterCompactStatus> {
    assertHash(approvalSummaryHash, "approval summary hash");
    let record = await this.loadRecord(taskId);
    const summary = this.approvalSummary(record);
    if (!hashesEqual(summary.approval_summary_hash, approvalSummaryHash)) throw new Error("Approval summary changed or was not the summary shown by router.prepare");
    const approvalLockHash = stableHash({ task_id: taskId, authority: "canonical-execution-approval" });
    const release = await this.attempts.tryAcquireWorktreeHandoffLock(taskId, approvalLockHash);
    if (!release) return this.waitForStatus(taskId);
    let lease: WorktreeLease;
    try {
      record = await this.loadRecord(taskId);
      const lockedSummary = this.approvalSummary(record);
      if (!hashesEqual(lockedSummary.approval_summary_hash, approvalSummaryHash)) throw new Error("Approval summary changed before the provider side-effect boundary");
      assertPricingCatalog(PRICING_CATALOG, this.now());
      this.assertRuntimeApprovalUnchanged(record);
      await this.assertQualityApprovalUnchanged(record);
      const checkpoint = await this.attempts.status(taskId);
      if (!checkpoint.workflow) throw new Error("Prepared workflow checkpoint is missing");
      if (["REVIEW_PENDING", "REPAIR_REQUIRED", "APPLY_PENDING", "PASSED", "BLOCKED", "ABORTED"].includes(checkpoint.workflow.state)) return this.status(taskId);
      if (!record.approval_record) {
        const approval = this.approvalRecord(record);
        record = { ...record, approval_record: approval, updated_at: this.now().toISOString() };
        await this.saveRecord(record);
      }
      const approval = record.approval_record;
      if (!approval) throw new Error("ApprovalRecord was not persisted");
      assertContractApproval(subject(record), approval, this.now());
      const workflow = await this.attempts.status(taskId);
      if (!workflow.workflow) throw new Error("Prepared workflow checkpoint is missing");
      if (workflow.workflow.approval_hash === preApprovalHashFor(record.task_package)) {
        await this.attempts.bindApproval(taskId, record.execution_context.run_id, workflow.workflow.approval_hash, approval.approval_hash);
      } else if (workflow.workflow.approval_hash !== approval.approval_hash) throw new Error("Workflow approval binding changed");
      lease = await this.worktrees.prepare(this.projectDirectory, record.worktree_binding);
      await this.attempts.markWorktreeReady(taskId, record.execution_context.run_id, approval.approval_hash);
    } catch (error) {
      if (record.approval_record) await this.attempts.blockLocalFailure(taskId, record.execution_context.run_id, record.approval_record.approval_hash, error).catch(() => undefined);
      throw error;
    } finally { await release(); }

    const current = await this.attempts.status(taskId);
    if (current.workflow && ["REVIEW_PENDING", "REPAIR_REQUIRED", "APPLY_PENDING", "PASSED", "BLOCKED", "ABORTED"].includes(current.workflow.state)) return this.status(taskId);
    const executionRelease = await this.attempts.tryAcquireWorktreeHandoffLock(taskId, stableHash({ task_id: taskId, authority: "canonical-execution-flow" }));
    if (!executionRelease) return this.waitForStatus(taskId);
    try {
      const locked = await this.attempts.status(taskId);
      if (locked.workflow && ["REVIEW_PENDING", "REPAIR_REQUIRED", "APPLY_PENDING", "PASSED", "BLOCKED", "ABORTED"].includes(locked.workflow.state)) return this.status(taskId);
      const execution = await this.executeProvider(record, lease, 0, undefined, approvalSummaryHash);
      if (!execution) return this.status(taskId);
      record = { ...record, execution_evidence: execution, updated_at: this.now().toISOString() };
      await this.saveRecord(record);
      const validation = await this.validateAndBundle(record, lease);
      record = validation.record;
      await this.worktrees.retain(lease);
      if (!validation.bundle.quality_passed) {
        await this.attempts.finalizeReview(taskId, record.execution_context.run_id, record.approval_record!.approval_hash, "BLOCKED", "Quality gate did not pass");
        const reviewedAt = this.now().toISOString(); const review = { decision: "BLOCKED" as const, summary: "Quality gate did not pass", reviewed_at: reviewedAt, evidence_bundle_hash: validation.bundle.bundle_hash };
        record = { ...record, final_review: review, review_history: [...record.review_history, review], updated_at: reviewedAt }; await this.saveRecord(record); if (this.realPilot) await this.materializePilotRecord(record);
      }
      return this.status(taskId);
    } catch (error) {
      await this.attempts.blockLocalFailure(taskId, record.execution_context.run_id, record.approval_record!.approval_hash, error).catch(() => undefined);
      return this.status(taskId);
    } finally { await executionRelease(); }
  }

  async status(taskId: string): Promise<RouterCompactStatus> {
    const record = await this.loadRecord(taskId);
    const durable = await this.attempts.status(taskId);
    if (!durable.workflow) throw new Error("Workflow checkpoint is missing");
    const evidence = record.evidence_bundle_hash && record.evidence_bundle_reference && record.quality_summary
      ? { bundle_hash: record.evidence_bundle_hash, reference: record.evidence_bundle_reference, quality_passed: record.quality_summary.quality_passed }
      : null;
    return {
      task_id: taskId,
      state: durable.workflow.state,
      approval_summary: this.approvalSummary(record),
      approved: record.approval_record !== null,
      attempts: durable.attempts.map(item => ({ attempt_id: item.attempt_id, stage: item.stage, status: item.status, failure_class: item.failure_class })),
      blocked_reason: durable.workflow.blocked_reason,
      evidence_bundle: evidence,
      final_review: record.final_review ? { decision: record.final_review.decision, summary: record.final_review.summary, reviewed_at: record.final_review.reviewed_at } : null,
      repair_count: record.repair_count,
      applied: record.apply_record?.status === "APPLIED",
      next: nextAction(durable.workflow.state, evidence !== null),
    };
  }

  async abort(taskId: string): Promise<RouterCompactStatus> {
    const record = await this.loadRecord(taskId);
    const approvalHash = record.approval_record?.approval_hash ?? preApprovalHashFor(record.task_package);
    await this.attempts.abort(taskId, record.execution_context.run_id, approvalHash);
    return this.status(taskId);
  }

  async reviewEvidence(taskId: string): Promise<RouterReviewEvidence> {
    const record = await this.loadRecord(taskId);
    if (!record.evidence_bundle_hash || !record.evidence_bundle_reference) throw new Error("EvidenceBundle is not available");
    const bytes = await readEvidenceArtifact(this.evidenceRoot, record.evidence_bundle_reference);
    const bundle = JSON.parse(bytes.toString("utf8")) as unknown;
    assertEvidenceBundle(bundle);
    if (bundle.task_id !== taskId || !hashesEqual(bundle.bundle_hash, record.evidence_bundle_hash)) throw new Error("EvidenceBundle reference is not bound to this task");
    const state = (await this.status(taskId)).state;
    return {
      task_id: taskId, state, evidence_bundle_hash: bundle.bundle_hash, evidence_bundle_reference: record.evidence_bundle_reference,
      quality_passed: bundle.quality_passed, files_changed: bundle.files_changed,
      quality_gate_results: bundle.quality_gate_results, tests_run: bundle.tests_run,
      route_evidence_summaries: bundle.route_evidence_summaries, scope_violations: bundle.scope_violations,
      privacy_violations: bundle.privacy_violations, remaining_risks: bundle.remaining_risks,
      diff_reference: bundle.diff_reference, diff_hash: bundle.diff_hash,
    };
  }

  async finalize(taskId: string, evidenceBundleHash: string, decision: FinalReviewDecision, summary: string): Promise<RouterCompactStatus> {
    if (!["PASS", "REPAIR_REQUIRED", "BLOCKED"].includes(decision)) throw new Error("Final review decision must be PASS, REPAIR_REQUIRED, or BLOCKED");
    assertHash(evidenceBundleHash, "EvidenceBundle hash");
    assertReviewSummary(summary);
    let record = await this.loadRecord(taskId);
    if (!record.approval_record || !record.evidence_bundle_hash || !hashesEqual(record.evidence_bundle_hash, evidenceBundleHash)) throw new Error("Final review is not bound to the current EvidenceBundle");
    if (record.final_review) {
      if (record.final_review.decision === decision && record.final_review.summary === summary) return this.status(taskId);
      throw new Error("Final review is already recorded and cannot be replaced");
    }
    if (decision === "REPAIR_REQUIRED" && record.repair_count >= 1) {
      await this.attempts.finalizeReview(taskId, record.execution_context.run_id, record.approval_record.approval_hash, "BLOCKED", "Controlled repair limit was already exhausted");
      const reviewedAt = this.now().toISOString();
      const blockedReview = { decision: "BLOCKED" as const, summary: "Controlled repair limit was already exhausted", reviewed_at: reviewedAt, evidence_bundle_hash: evidenceBundleHash };
      record = { ...record, final_review: blockedReview, review_history: [...record.review_history, blockedReview], updated_at: reviewedAt };
      await this.saveRecord(record);
      if (this.realPilot) await this.materializePilotRecord(record);
      return this.status(taskId);
    }
    if (decision === "PASS" && !record.quality_summary?.quality_passed) throw new Error("Final review cannot PASS when the quality gate did not pass");
    await this.attempts.finalizeReview(taskId, record.execution_context.run_id, record.approval_record.approval_hash, decision, summary);
    const reviewedAt = this.now().toISOString();
    const review = { decision, summary, reviewed_at: reviewedAt, evidence_bundle_hash: evidenceBundleHash };
    record = { ...record, final_review: review, review_history: [...record.review_history, review], updated_at: reviewedAt };
    await this.saveRecord(record);
    if (decision !== "REPAIR_REQUIRED" && this.realPilot) await this.materializePilotRecord(record);
    return this.status(taskId);
  }

  async pilotReport(taskId: string): Promise<PilotRunRecord> {
    const record = await this.loadRecord(taskId);
    if (!record.pilot_record_hash || !record.pilot_record_reference || !record.evidence_bundle_hash) throw new Error("PilotRunRecord is not available before a terminal Final Review");
    const report = await readPilotRunRecord(this.store.root, taskId, record.execution_context.run_id, record.evidence_bundle_hash);
    if (!hashesEqual(report.record_hash, record.pilot_record_hash) || record.pilot_record_reference !== `tasks/${taskId}/pilot-runs/${record.execution_context.run_id}.json`) throw new Error("PilotRunRecord persisted-state binding changed");
    return report;
  }

  async repair(taskId: string, evidenceBundleHash: string, approvalSummaryHash: string): Promise<RouterCompactStatus> {
    assertHash(evidenceBundleHash, "EvidenceBundle hash"); assertHash(approvalSummaryHash, "approval summary hash");
    let record = await this.loadRecord(taskId);
    if (!record.approval_record || !record.final_review || record.final_review.decision !== "REPAIR_REQUIRED" || !hashesEqual(record.final_review.evidence_bundle_hash, evidenceBundleHash) || !hashesEqual(record.evidence_bundle_hash ?? "", evidenceBundleHash)) throw new Error("Controlled repair is not bound to the current REPAIR_REQUIRED review");
    if (record.repair_count >= 1) { await this.attempts.blockLocalFailure(taskId, record.execution_context.run_id, record.approval_record.approval_hash, "Controlled repair limit was already exhausted"); return this.status(taskId); }
    if (!hashesEqual(this.approvalSummary(record).approval_summary_hash, approvalSummaryHash)) { await this.attempts.blockLocalFailure(taskId, record.execution_context.run_id, record.approval_record.approval_hash, "Repair requested a provider, model, budget, scope, privacy, or approval change"); return this.status(taskId); }
    const release = await this.attempts.tryAcquireWorktreeHandoffLock(taskId, stableHash({ task_id: taskId, authority: "controlled-repair" }));
    if (!release) return this.waitForStatus(taskId);
    try {
      record = await this.loadRecord(taskId);
      if (!record.approval_record || !record.final_review || record.final_review.decision !== "REPAIR_REQUIRED" || !hashesEqual(record.final_review.evidence_bundle_hash, evidenceBundleHash) || !hashesEqual(record.evidence_bundle_hash ?? "", evidenceBundleHash)) return this.status(taskId);
      if (record.repair_count >= 1) return this.status(taskId);
      if (!hashesEqual(this.approvalSummary(record).approval_summary_hash, approvalSummaryHash)) { await this.attempts.blockLocalFailure(taskId, record.execution_context.run_id, record.approval_record.approval_hash, "Repair requested a provider, model, budget, scope, privacy, or approval change"); return this.status(taskId); }
      this.assertRuntimeApprovalUnchanged(record);
      await this.assertQualityApprovalUnchanged(record);
      assertContractApproval(subject(record), record.approval_record, this.now());
      const lease = await this.worktrees.prepare(this.projectDirectory, record.worktree_binding);
      await this.assertRepairBoundaries(record, lease);
      const repairInstruction = record.final_review.summary;
      record = { ...record, repair_count: 1, updated_at: this.now().toISOString() };
      await this.saveRecord(record);
      const execution = await this.executeProvider(record, lease, 1, repairInstruction, approvalSummaryHash);
      if (!execution) return this.status(taskId);
      record = { ...record, execution_evidence: execution, final_review: null, updated_at: this.now().toISOString() };
      await this.saveRecord(record);
      const validation = await this.validateAndBundle(record, lease, 1);
      record = validation.record;
      await this.worktrees.retain(lease);
      if (!validation.bundle.quality_passed) { await this.attempts.finalizeReview(taskId, record.execution_context.run_id, record.approval_record!.approval_hash, "BLOCKED", "Quality gate did not pass after the only controlled repair"); const reviewedAt = this.now().toISOString(); const review = { decision: "BLOCKED" as const, summary: "Quality gate did not pass after the only controlled repair", reviewed_at: reviewedAt, evidence_bundle_hash: validation.bundle.bundle_hash }; record = { ...record, final_review: review, review_history: [...record.review_history, review], updated_at: reviewedAt }; await this.saveRecord(record); if (this.realPilot) await this.materializePilotRecord(record); }
      return this.status(taskId);
    } catch (error) {
      await this.attempts.blockLocalFailure(taskId, record.execution_context.run_id, record.approval_record!.approval_hash, error).catch(() => undefined);
      return this.status(taskId);
    } finally { await release(); }
  }

  async apply(taskId: string, evidenceBundleHash: string): Promise<RouterCompactStatus> {
    assertHash(evidenceBundleHash, "EvidenceBundle hash");
    let record = await this.loadRecord(taskId);
    if (record.apply_record?.status === "APPLIED") {
      if (!hashesEqual(record.apply_record.evidence_bundle_hash, evidenceBundleHash)) throw new Error("A different EvidenceBundle was already applied");
      if (record.approval_record) await this.attempts.completeApply(taskId, record.execution_context.run_id, record.approval_record.approval_hash);
      return this.status(taskId);
    }
    if (!record.approval_record || !record.final_review || record.final_review.decision !== "PASS" || !hashesEqual(record.final_review.evidence_bundle_hash, evidenceBundleHash) || !hashesEqual(record.evidence_bundle_hash ?? "", evidenceBundleHash)) throw new Error("Controlled apply is not bound to the current PASS review");
    const release = await this.attempts.tryAcquireWorktreeHandoffLock(taskId, stableHash({ task_id: taskId, authority: "controlled-apply" }));
    if (!release) return this.waitForStatus(taskId);
    try {
      record = await this.loadRecord(taskId);
      if (record.apply_record?.status === "APPLIED") { await this.attempts.completeApply(taskId, record.execution_context.run_id, record.approval_record!.approval_hash); return this.status(taskId); }
      this.assertRuntimeApprovalUnchanged(record);
      assertContractApproval(subject(record), record.approval_record!, this.now());
      const workflow = await this.attempts.status(taskId);
      if (workflow.workflow?.state !== "APPLY_PENDING") throw new Error("Workflow is not pending controlled apply");
      const bundle = await this.loadCurrentBundle(record);
      const lease = await this.worktrees.prepare(this.projectDirectory, record.worktree_binding);
      await this.worktrees.assertApplyPreconditions(lease);
      const targets = await this.prepareApplyTargets(record, lease, bundle);
      const preparedAt = this.now().toISOString();
      record = { ...record, apply_record: { status: "PREPARED", evidence_bundle_hash: bundle.bundle_hash, diff_hash: bundle.diff_hash, targets: targets.map(({ replacement: _replacement, ...target }) => target), prepared_at: preparedAt, applied_at: null }, updated_at: preparedAt };
      await this.saveRecord(record);
      await applyStructuredPatches(lease.main_directory, await this.mainApplyGrant(record, targets), targets.map(target => ({ path: target.path, preimageHash: target.preimage_hash, replacement: target.replacement })));
      const appliedAt = this.now().toISOString();
      record = { ...record, apply_record: { ...record.apply_record!, status: "APPLIED", applied_at: appliedAt }, updated_at: appliedAt };
      await this.saveRecord(record);
      await this.attempts.completeApply(taskId, record.execution_context.run_id, record.approval_record!.approval_hash);
      return this.status(taskId);
    } catch (error) {
      if (record.approval_record) await this.attempts.blockLocalFailure(taskId, record.execution_context.run_id, record.approval_record.approval_hash, error).catch(() => undefined);
      return this.status(taskId);
    } finally { await release(); }
  }

  private async executeProvider(record: CoreRecord, lease: WorktreeLease, round = 0, repairInstruction?: string, approvedSummaryHash?: string): Promise<CoreExecutionEvidence | undefined> {
    const approval = record.approval_record!;
    const stage = round === 0 ? "EXECUTE" as const : "REPAIR" as const;
    const route = routeDecision(record.route_binding, stage);
    const executorCapabilities = await buildExecutorCapabilityGrant(lease.checkout_directory, record.route_binding.read_scope, record.route_binding.write_scope, record.task_package.data_classification);
    this.assertProviderEgressBoundaries(record, executorCapabilities);
    const prompt = buildPrompt(
      stage,
      round === 0 ? "Perform only the approved TaskPackage. Use only the provided manifest tools and stop on any boundary mismatch." : "Repair only the foreground review issue within the unchanged approved TaskPackage and capability manifest. Stop on any boundary mismatch.",
      "Return a concise execution summary after exactly one structured patch proposal.",
      JSON.stringify({ goal: record.task_package.goal, acceptance_criteria: record.task_package.acceptance_criteria, non_goals: record.task_package.non_goals, forbidden_actions: record.task_package.forbidden_actions, relevant_interfaces: record.task_package.relevant_interfaces, validation_requirements: record.task_package.validation_requirements, stop_conditions: record.task_package.stop_conditions, ...(repairInstruction === undefined ? {} : { repair_instruction: repairInstruction }) }),
      JSON.stringify({ task_id: record.task_package.task_id, context_manifest: record.task_package.context_manifest }),
      sensitivityFor(record.task_package),
    );
    const request = {
      stage, contractProvenance: "canonical" as const, route, routeBinding: record.route_binding, ...prompt,
      sensitivity: sensitivityFor(record.task_package), workingDirectory: lease.checkout_directory,
      allowedFiles: record.route_binding.write_scope, executorCapabilities, budgetState: await this.providerBudgetState(record),
    } satisfies ProviderRequest;
    const attempt = attemptRequest(record, request, round === 0 ? "WORKTREE_READY" : "REPAIR_REQUIRED", "EXECUTING", "VALIDATING", round);
    const operation = {
      prepare: async () => {
        const current = await this.loadRecord(record.task_package.task_id);
        if (approvedSummaryHash === undefined || !hashesEqual(this.approvalSummary(current).approval_summary_hash, approvedSummaryHash)) throw new Error("Approval summary changed immediately before the provider side-effect boundary");
        assertPricingCatalog(PRICING_CATALOG, this.now()); this.assertRuntimeApprovalUnchanged(current); await this.assertQualityApprovalUnchanged(current, lease.checkout_directory); assertContractApproval(subject(current), current.approval_record!, this.now());
        preflightRouteBinding(record.route_binding, route, adapterIdFor(route.provider), "canonical");
        if (!this.dependencies.model_adapter.preflight) throw new Error("Bound provider adapter does not implement route preflight");
        await this.dependencies.model_adapter.preflight(request);
      },
      send: () => this.dependencies.model_adapter.invoke(request),
      validate: async (response: ProviderResponse) => {
        assertProviderResponse(request, response);
        if (!Array.isArray(response.structuredPatches) || response.structuredPatches.length !== 1) throw new Error("Canonical Direct DeepSeek execution requires exactly one structured patch proposal");
        await this.assertCumulativeBudget(record, { input_tokens: response.usage.inputTokens, output_tokens: response.usage.outputTokens });
        await applyStructuredPatches(lease.checkout_directory, executorCapabilities, response.structuredPatches);
        return verifiedMetadata(response);
      },
    };
    const result = round === 0 ? await this.attempts.execute(attempt, operation) : await this.attempts.repair(attempt, operation);
    if (result.attempt.status === "FAILED_BEFORE_SEND") {
      await this.attempts.blockLocalFailure(record.task_package.task_id, record.execution_context.run_id, approval.approval_hash, result.attempt.redacted_error ?? "Provider preflight failed");
      return undefined;
    }
    if (result.attempt.status !== "SUCCEEDED") return undefined;
    return {
      attempt_id: result.attempt.attempt_id,
      provider_request_id: result.attempt.provider_request_id!, response_model: result.attempt.response_model!, response_origin: result.attempt.response_origin!,
      input_tokens: result.attempt.usage!.input_tokens, output_tokens: result.attempt.usage!.output_tokens, reasoning_tokens: result.attempt.usage!.reasoning_tokens,
    };
  }

  private async validateAndBundle(record: CoreRecord, lease: WorktreeLease, round = 0): Promise<{ record: CoreRecord; bundle: EvidenceBundle }> {
    const approval = record.approval_record!;
    const route = localRouteDecision(this.qualityPolicy.max_wall_time_ms);
    const qualityGate = qualityGateRequestFor(record.task_package, record.route_binding, record.execution_context, record.worktree_binding, this.qualityPolicy, this.qualityCatalog?.catalog_hash ?? this.qualityPolicy.command_registry_hash, record.fixture_hash, record.hidden_root_hash, approval.approval_hash);
    if (record.quality_boundary && this.qualityCatalog) {
      const fixtureHash = await hashQualityFixtureRoot(this.fixtureRoot);
      const hiddenRootHash = this.hiddenRoot ? await hashHiddenAcceptanceRoot(this.hiddenRoot) : null;
      assertQualityGateRuntimeBinding(record.quality_boundary, { request: qualityGate, policy: this.qualityPolicy, catalog: this.qualityCatalog, fixtureHash, hiddenRootHash, worktreeRoot: lease.checkout_directory, evidenceRoot: this.evidenceRoot, realPilot: this.realPilot });
    }
    const request = { stage: "VALIDATE" as const, contractProvenance: "canonical" as const, route, stablePrefix: "", projectSummary: "", dynamicInput: "structured-quality-gate", sensitivity: sensitivityFor(record.task_package), workingDirectory: lease.checkout_directory, qualityGate } satisfies ProviderRequest;
    const result = await this.attempts.execute(attemptRequest(record, request, "VALIDATING", "VALIDATING", "REVIEW_PENDING", round), {
      prepare: () => this.dependencies.local_adapter.preflight?.(request),
      send: () => this.dependencies.local_adapter.invoke(request),
      validate: response => {
        if (response.provider !== "local" || response.model !== route.model || !response.requestId) throw new Error("Local quality response identity was incomplete");
        const report = JSON.parse(response.text) as QualityGateReport;
        assertQualityGateReportForRequest(report, qualityGate);
        return verifiedMetadata(response);
      },
    });
    if (!result.response || result.attempt.status !== "SUCCEEDED") {
      await this.attempts.blockLocalFailure(record.task_package.task_id, record.execution_context.run_id, approval.approval_hash, "Quality report was not durably available");
      throw new Error("Quality report was not durably available; provider execution will not be retried");
    }
    const report = JSON.parse(result.response.text) as QualityGateReport;
    assertQualityGateReportForRequest(report, qualityGate);
    const acceptanceResults = record.quality_boundary && this.qualityCatalog && report.hidden_acceptance_result
      ? createQualityAcceptanceProjection(report, this.qualityCatalog, record.quality_boundary, report.hidden_acceptance_result)
      : fallbackAcceptanceProjection(report, record.fixture_hash);
    const beforeBundle = report.passed ? await snapshotWorkingTree(lease.checkout_directory) : undefined;
    if (beforeBundle && ([...beforeBundle.keys()].sort().join("\0") !== report.files_changed.join("\0") || hashScopeSnapshot(beforeBundle) !== report.worktree_snapshot_hash)) throw new Error("Quality report did not match the frozen worktree content");
    await readEvidenceArtifact(this.evidenceRoot, report.diff_reference, report.diff_hash);
    const attempts = (await this.attempts.status(record.task_package.task_id)).attempts;
    const executionAttempt = attempts.find(item => item.attempt_id === record.execution_evidence!.attempt_id);
    if (!executionAttempt || executionAttempt.status !== "SUCCEEDED") throw new Error("Execution attempt evidence is missing");
    const succeededAttempts = attempts.filter(item => item.status === "SUCCEEDED");
    const routeEvidenceIds = succeededAttempts.map((item, occurrence) => `route-${stableHash({ attempt_id: item.attempt_id, occurrence }).slice(0, 24)}`);
    const modelAttempts = succeededAttempts.filter(item => item.stage === "EXECUTE" || item.stage === "REPAIR");
    const transportRounds = attempts.flatMap(item => item.transport_rounds);
    const usage = modelAttempts.reduce((total, item) => ({
      input_tokens: total.input_tokens + (item.usage?.input_tokens ?? 0), output_tokens: total.output_tokens + (item.usage?.output_tokens ?? 0), reasoning_tokens: total.reasoning_tokens + (item.usage?.reasoning_tokens ?? 0),
      cached_input_tokens: total.cached_input_tokens + (item.usage?.cached_input_tokens ?? 0), cache_write_tokens: total.cache_write_tokens + (item.usage?.cache_write_tokens ?? 0),
      cache_hit_tokens: total.cache_hit_tokens + (item.usage?.cache_hit_tokens ?? 0), cache_miss_tokens: total.cache_miss_tokens + (item.usage?.cache_miss_tokens ?? 0),
    }), { input_tokens: 0, output_tokens: 0, reasoning_tokens: 0, cached_input_tokens: 0, cache_write_tokens: 0, cache_hit_tokens: 0, cache_miss_tokens: 0 });
    const modelRounds = modelAttempts.flatMap(item => item.transport_rounds);
    const estimatedListCost = modelRounds.length && modelRounds.every(item => item.estimated_list_cost_usd !== null) ? sumCosts(modelRounds.map(item => item.estimated_list_cost_usd!)) : null;
    const providerReportedCost = modelRounds.length && modelRounds.every(item => item.provider_reported_cost_usd !== null) ? sumCosts(modelRounds.map(item => item.provider_reported_cost_usd!)) : null;
    const pricedBands = modelRounds.map(item => item.pricing_time_band).filter((item): item is NonNullable<typeof item> => item !== null);
    const executeWall = sumRoundWall(modelAttempts.filter(item => item.stage === "EXECUTE").flatMap(item => item.transport_rounds));
    const repairWall = sumRoundWall(modelAttempts.filter(item => item.stage === "REPAIR").flatMap(item => item.transport_rounds));
    const bundle = createEvidenceBundle({
      version: 4, bundle_id: `bundle-${stableHash({ run: record.execution_context.run_id, content: report.content_snapshot_hash, repair_count: record.repair_count, quality_report_hash: report.report_hash }).slice(0, 24)}`,
      run_id: record.execution_context.run_id, task_id: record.task_package.task_id, contract_provenance: "canonical",
      task_package_hash: record.task_package.task_package_hash, route_binding_hash: record.route_binding.route_binding_hash,
      policy_hash: record.effective_policy.policy_hash, quality_policy_hash: this.qualityPolicy.policy_hash,
      quality_approval_boundary_hash: report.approval_boundary_hash, quality_catalog_hash: qualityGate.catalog_hash,
      fixture_hash: record.fixture_hash, hidden_root_hash: record.hidden_root_hash, acceptance_results: acceptanceResults,
      hidden_acceptance_result: report.hidden_acceptance_result,
      quality_policy: { ...this.qualityPolicy, command_ids: [...this.qualityPolicy.command_ids] }, approval_hash: approval.approval_hash,
      execution_context_hash: record.execution_context.execution_context_hash, isolation_hash: record.worktree_binding.isolation_hash,
      worktree_id: record.execution_context.worktree_id, base_commit: record.execution_context.base_commit, worktree_head: report.worktree_head,
      quality_request_hash: report.request_hash, quality_report_hash: report.report_hash, quality_passed: report.passed,
      quality_write_scope: [...record.route_binding.write_scope], quality_command_ids: [...this.qualityPolicy.command_ids],
      post_artifact_snapshot_hash: report.post_artifact_snapshot_hash, worktree_snapshot_hash: report.worktree_snapshot_hash,
      attempt_ids: attempts.map(item => item.attempt_id), route_evidence_ids: routeEvidenceIds,
      attempt_summaries: attempts.map(item => ({ attempt_id: item.attempt_id, stage: item.stage, status: item.status, failure_class: item.failure_class })),
      route_evidence_summaries: succeededAttempts.map((item, index) => ({ evidence_id: routeEvidenceIds[index], provider: item.stage === "VALIDATE" ? "local" : record.route_binding.provider_id, model: item.response_model!, verification_status: item.stage === "VALIDATE" ? "local" as const : "route_tuple_verified_peer_unobserved" as const, request_id_present: item.provider_request_id !== null })),
      transport_rounds: transportRounds,
      files_changed: [...report.files_changed], content_snapshot_hash: report.content_snapshot_hash, diff_hash: report.diff_hash, diff_reference: report.diff_reference,
      quality_gate_results: report.quality_gate_results, tests_run: report.tests_run, scope_violations: report.scope_violations, privacy_violations: report.privacy_violations,
      secret_scan_summary: report.secret_scan_summary,
      usage_metrics: usage,
      cost_metrics: { provider_reported_usd: providerReportedCost, estimated_list_usd: estimatedListCost, invoice_usd: null, chatgpt_quota: null },
      pricing_catalog: estimatedListCost === null ? null : pricingCatalogEvidence(pricedBands),
      wall_clock_time_ms: report.wall_clock_time_ms,
      stage_wall_clock_ms: { plan: null, execute: executeWall, gate: report.wall_clock_time_ms, review: null, repair: repairWall, total: executeWall + report.wall_clock_time_ms + repairWall },
      repair_count: record.repair_count,
      remaining_risks: ["project_commands_not_os_sandboxed", "secret_scan_is_heuristic", "network_peer_and_proxy_not_observable", "apply_is_uncommitted_workspace_edit"],
      redaction_notes: report.redaction_notes,
    });
    const reference = await persistEvidenceBundle(this.evidenceRoot, bundle);
    if (beforeBundle) {
      const afterBundle = await snapshotWorkingTree(lease.checkout_directory);
      if (stableHash([...beforeBundle]) !== stableHash([...afterBundle])) throw new Error("Worktree changed while EvidenceBundle was being persisted");
    }
    const updated: CoreRecord = {
      ...record, evidence_bundle_hash: bundle.bundle_hash, evidence_bundle_reference: reference,
      quality_summary: { quality_passed: bundle.quality_passed, files_changed: [...bundle.files_changed], gate_failures: bundle.quality_gate_results.filter(item => item.outcome === "failed").map(item => item.gate_id) },
      updated_at: this.now().toISOString(),
    };
    await this.saveRecord(updated);
    return { record: updated, bundle };
  }

  private async loadCurrentBundle(record: CoreRecord): Promise<EvidenceBundle> {
    if (!record.evidence_bundle_hash || !record.evidence_bundle_reference) throw new Error("EvidenceBundle is not available");
    const bytes = await readEvidenceArtifact(this.evidenceRoot, record.evidence_bundle_reference);
    const bundle = JSON.parse(bytes.toString("utf8")) as unknown;
    assertEvidenceBundle(bundle);
    if (bundle.task_id !== record.task_package.task_id || bundle.run_id !== record.execution_context.run_id || bundle.worktree_id !== record.execution_context.worktree_id || bundle.base_commit !== record.execution_context.base_commit || bundle.isolation_hash !== record.worktree_binding.isolation_hash || !hashesEqual(bundle.bundle_hash, record.evidence_bundle_hash) || !hashesEqual(bundle.task_package_hash, record.task_package.task_package_hash) || !hashesEqual(bundle.route_binding_hash, record.route_binding.route_binding_hash) || !hashesEqual(bundle.policy_hash, record.effective_policy.policy_hash) || !hashesEqual(bundle.approval_hash, record.approval_record!.approval_hash) || !hashesEqual(bundle.quality_policy_hash, this.qualityPolicy.policy_hash) || bundle.fixture_hash !== record.fixture_hash || bundle.hidden_root_hash !== record.hidden_root_hash || (record.quality_boundary !== null && (bundle.quality_approval_boundary_hash !== record.quality_boundary.approval_boundary_hash || bundle.quality_catalog_hash !== record.quality_boundary.catalog_hash))) throw new Error("EvidenceBundle is not bound to the unchanged approved contracts and quality boundary");
    return bundle;
  }

  private async materializePilotRecord(record: CoreRecord): Promise<CoreRecord> {
    if (!record.final_review || record.final_review.decision === "REPAIR_REQUIRED" || !record.approval_record || !record.evidence_bundle_hash) throw new Error("PilotRunRecord requires a terminal Final Review and current approved evidence");
    if (record.pilot_record_hash !== null) { await this.pilotReport(record.task_package.task_id); return record; }
    const bundle = await this.loadCurrentBundle(record); const durable = await this.attempts.status(record.task_package.task_id); const observed = await this.worktrees.captureMainWorkspace(this.projectDirectory);
    const pilot = createPilotRunRecordFromEvidence({ arm: "hybrid", persisted_state: { task_package: record.task_package, effective_policy: record.effective_policy, route_binding: record.route_binding, execution_context: record.execution_context, approval_record: record.approval_record, final_review: record.final_review, review_history: record.review_history, repair_count: record.repair_count, human_interventions: [] }, attempts: durable.attempts, evidence_bundle: bundle, observed_main_workspace_snapshot: observed.main_workspace_snapshot, created_at: record.final_review.reviewed_at });
    await persistPilotRunRecord(this.store.root, pilot);
    const updated = { ...record, pilot_record_hash: pilot.record_hash, pilot_record_reference: `tasks/${record.task_package.task_id}/pilot-runs/${record.execution_context.run_id}.json`, updated_at: this.now().toISOString() };
    await this.saveRecord(updated); return updated;
  }

  private assertRuntimeApprovalUnchanged(record: CoreRecord): void {
    if (!hashesEqual(this.effectivePolicy.policy_hash, record.effective_policy.policy_hash)) throw new Error("Runtime privacy or project policy changed and requires a new approval");
    const current = freezeRouteBinding(buildRouteBinding({
      ...this.routeProfile,
      request_budget: this.routeProfile.request_budget ?? record.task_package.request_budget,
      read_scope: [...record.task_package.read_scope],
      write_scope: [...record.task_package.write_scope],
    }, record.task_package, this.effectivePolicy, this.now()));
    if (!hashesEqual(current.route_binding_hash, record.route_binding.route_binding_hash)) throw new Error("Runtime provider, model, budget, scope, or privacy binding changed and requires a new approval");
  }

  private async assertQualityApprovalUnchanged(record: CoreRecord, actualWorktreeRoot?: string): Promise<void> {
    if (!record.quality_boundary) {
      if (this.realPilot) throw new Error("Pilot quality approval boundary is missing");
      return;
    }
    if (!this.qualityCatalog) throw new Error("Trusted quality catalog changed or is unavailable");
    const fixtureHash = await hashQualityFixtureRoot(this.fixtureRoot);
    const hiddenRootHash = this.hiddenRoot ? await hashHiddenAcceptanceRoot(this.hiddenRoot) : null;
    const approval = record.approval_record ?? this.approvalRecord(record);
    const request = qualityGateRequestFor(record.task_package, record.route_binding, record.execution_context, record.worktree_binding, this.qualityPolicy, this.qualityCatalog.catalog_hash, fixtureHash, hiddenRootHash, approval.approval_hash);
    const worktreeRoot = actualWorktreeRoot ?? record.quality_boundary.worktree_root;
    if (actualWorktreeRoot !== undefined && path.resolve(actualWorktreeRoot) !== record.quality_boundary.worktree_root) throw new Error("Prepared checkout directory differs from the approved quality command cwd");
    assertQualityGateRuntimeBinding(record.quality_boundary, { request, policy: this.qualityPolicy, catalog: this.qualityCatalog, fixtureHash, hiddenRootHash, worktreeRoot, evidenceRoot: this.evidenceRoot, realPilot: this.realPilot });
  }

  private async assertPilotRootIsolation(): Promise<void> {
    if (!this.hiddenRoot) throw new Error("Pilot hidden root is unavailable");
    const physical = async (value: string) => realpath(value).catch(() => path.resolve(value));
    const hidden = await physical(this.hiddenRoot);
    for (const [label, candidate] of [["project", this.projectDirectory], ["fixture", this.fixtureRoot], ["state", this.store.root], ["worktree", this.worktrees.managedRoot], ["evidence", this.evidenceRoot]] as const) {
      if (rootsOverlap(hidden, await physical(candidate))) throw new Error(`Pilot hidden root must not overlap the ${label} root`);
    }
  }

  private approvalSummary(record: CoreRecord): RouterApprovalSummary {
    const preparedAt = Date.parse(record.created_at);
    if (!Number.isFinite(preparedAt)) throw new Error("Router approval preparation timestamp is invalid");
    const pricingMatches = record.route_binding.pricing_catalog_version === PRICING_CATALOG.version
      && record.route_binding.pricing_catalog_hash === PRICING_CATALOG.catalog_hash;
    const base = {
      task_id: record.task_package.task_id,
      goal: record.task_package.goal,
      provider: record.route_binding.provider_id,
      model: record.route_binding.model_id,
      data_classification: record.task_package.data_classification,
      read_scope: [...record.route_binding.read_scope],
      write_scope: [...record.route_binding.write_scope],
      budget: { ...record.route_binding.request_budget },
      task_package_hash: record.task_package.task_package_hash,
      route_binding_hash: record.route_binding.route_binding_hash,
      execution_context_hash: record.execution_context.execution_context_hash,
      policy_hash: record.effective_policy.policy_hash,
      adapter_id: record.route_binding.adapter_id,
      endpoint_origin: record.route_binding.endpoint_origin,
      endpoint_path: record.route_binding.endpoint_path,
      wire_protocol: record.route_binding.wire_protocol,
      auth_alias: record.route_binding.auth_alias,
      reasoning_mode: record.route_binding.reasoning_mode,
      reasoning_effort: record.route_binding.reasoning_effort,
      pricing: {
        version: record.route_binding.pricing_catalog_version,
        hash: record.route_binding.pricing_catalog_hash,
        retrieved_at: pricingMatches ? PRICING_CATALOG.retrieved_at : "unavailable",
        valid_at: record.created_at,
        valid_until: pricingMatches ? PRICING_CATALOG.valid_until : "unavailable",
      },
      egress_policy: structuredClone(record.task_package.egress_policy),
      quality: {
        policy_hash: this.qualityPolicy.policy_hash,
        command_catalog_hash: this.qualityPolicy.command_registry_hash,
        command_ids: [...this.qualityPolicy.command_ids],
        approval_boundary_hash: record.quality_boundary?.approval_boundary_hash ?? null,
        fixture_hash: record.fixture_hash,
        hidden_root_hash: record.hidden_root_hash,
        commands: record.quality_boundary ? structuredClone(record.quality_boundary.commands) : [],
        max_output_bytes: this.qualityPolicy.max_output_bytes,
        max_wall_time_ms: this.qualityPolicy.max_wall_time_ms,
      },
      roots: {
        project: this.projectDirectory,
        state: this.store.root,
        worktree: this.worktrees.managedRoot,
        evidence: this.evidenceRoot,
        fixture: this.fixtureRoot,
        hidden: this.hiddenRoot,
      },
      isolation: {
        base_commit: record.execution_context.base_commit,
        main_workspace_snapshot: record.execution_context.main_workspace_snapshot,
        isolation_hash: record.worktree_binding.isolation_hash,
      },
      hidden_data: {
        model_context_excluded: true as const,
        egress_excluded: true as const,
        result_mode: "bounded_redacted_only" as const,
      },
      restrictions: {
        redirect: "forbidden" as const,
        escalation: "forbidden" as const,
        automatic_retry: "forbidden" as const,
        apply: "separate_explicit_action" as const,
        commit: "forbidden" as const,
        push: "forbidden" as const,
      },
      stop_conditions: [...record.task_package.stop_conditions],
      approval_expires_at: new Date(preparedAt + this.approvalTtlMs).toISOString(),
    };
    return { ...base, approval_summary_hash: stableHash(base) };
  }

  private approvalRecord(record: CoreRecord): ApprovalRecord {
    return approveContracts(subject(record), {
      approvalId: approvalIdFor(record.task_package.task_id, record.execution_context.execution_context_hash),
      approvedAt: new Date(record.created_at),
      expiresAt: new Date(Date.parse(record.created_at) + this.approvalTtlMs),
      scopeSummary: `${record.route_binding.provider_id}: read ${record.route_binding.read_scope.length}, write ${record.route_binding.write_scope.length}`,
    });
  }

  private async assertRepairBoundaries(record: CoreRecord, lease: WorktreeLease): Promise<void> {
    if (record.apply_record) throw new Error("Applied or prepared changes cannot be repaired");
    const bundle = await this.loadCurrentBundle(record);
    const snapshot = await snapshotWorkingTree(lease.checkout_directory);
    if ([...snapshot.keys()].sort().join("\0") !== bundle.files_changed.join("\0") || hashScopeSnapshot(snapshot) !== bundle.worktree_snapshot_hash) throw new Error("Repair worktree changed after the reviewed EvidenceBundle");
    const grant = await buildExecutorCapabilityGrant(lease.checkout_directory, record.route_binding.read_scope, record.route_binding.write_scope, record.task_package.data_classification);
    this.assertProviderEgressBoundaries(record, grant);
    await this.assertCumulativeBudget(record, { input_tokens: 0, output_tokens: 0 });
  }

  private assertProviderEgressBoundaries(record: CoreRecord, grant: ExecutorCapabilityGrant): void {
    for (const egress of [record.task_package.egress_policy, record.effective_policy.egress_policy]) {
      if (egress.mode !== "allow" || !egress.providers.includes(record.route_binding.provider_id) || grant.readManifest.some(entry => !egress.paths.includes(entry.path) || !egress.content_hashes.includes(entry.contentHash))) throw new Error("Provider execution would require new provider, privacy, path, or content-hash egress approval");
    }
  }

  private async assertCumulativeBudget(record: CoreRecord, pending?: { input_tokens: number; output_tokens: number }): Promise<void> {
    const attempts = (await this.attempts.status(record.task_package.task_id)).attempts.filter(item => (item.stage === "EXECUTE" || item.stage === "REPAIR") && item.status === "SUCCEEDED");
    const budget = record.route_binding.request_budget;
    if (attempts.length + (pending ? 1 : 0) > budget.max_attempts) throw new Error("Model execution would exceed the unchanged approved attempt budget");
    const input = attempts.reduce((sum, item) => sum + (item.usage?.input_tokens ?? 0), 0) + (pending?.input_tokens ?? 0);
    const output = attempts.reduce((sum, item) => sum + (item.usage?.output_tokens ?? 0), 0) + (pending?.output_tokens ?? 0);
    if (input > budget.max_input_tokens || output > budget.max_output_tokens) throw new Error("Model execution would exceed the unchanged approved token budget");
  }

  private async providerBudgetState(record: CoreRecord): Promise<ProviderBudgetState> {
    const attempts = (await this.attempts.status(record.task_package.task_id)).attempts.filter(item => (item.stage === "EXECUTE" || item.stage === "REPAIR") && item.status === "SUCCEEDED");
    const rounds = attempts.flatMap(item => item.transport_rounds);
    return {
      attempts_used: attempts.length,
      provider_requests_used: rounds.length,
      input_tokens_used: attempts.reduce((sum, item) => sum + (item.usage?.input_tokens ?? 0), 0),
      output_tokens_used: attempts.reduce((sum, item) => sum + (item.usage?.output_tokens ?? 0), 0),
      wall_clock_time_ms_used: rounds.reduce((sum, item) => sum + (item.wall_clock_time_ms ?? 0), 0),
      estimated_list_cost_usd: attempts.reduce((sum, item) => sum + (item.estimated_list_cost_usd ?? 0), 0),
    };
  }

  private async prepareApplyTargets(record: CoreRecord, lease: WorktreeLease, bundle: EvidenceBundle): Promise<ApplyTarget[]> {
    if (!bundle.quality_passed || bundle.scope_violations.length || bundle.privacy_violations.length || bundle.secret_scan_summary.outcome !== "passed") throw new Error("Only a clean passing EvidenceBundle can be applied");
    if (bundle.files_changed.length !== 1) throw new Error("S8 controlled apply supports exactly one reviewed file target");
    const snapshot = await snapshotWorkingTree(lease.checkout_directory);
    if ([...snapshot.keys()].sort().join("\0") !== bundle.files_changed.join("\0") || hashScopeSnapshot(snapshot) !== bundle.worktree_snapshot_hash) throw new Error("Apply worktree changed after the PASS EvidenceBundle");
    const outputGrant = await buildExecutorCapabilityGrant(lease.checkout_directory, bundle.files_changed, record.route_binding.write_scope, record.task_package.data_classification);
    const output = await new SafeExecutor(lease.checkout_directory, outputGrant).readFile(bundle.files_changed[0]);
    if (snapshot.get(output.path) !== output.contentHash) throw new Error("Apply target no longer matches the reviewed postimage");
    const context = record.task_package.context_manifest.find(item => item.path === output.path && item.kind === "file" && item.selector === null);
    let preimage: string | null = null;
    if (context) {
      const mainGrant = await buildExecutorCapabilityGrant(lease.main_directory, [output.path], record.route_binding.write_scope, record.task_package.data_classification);
      const current = await new SafeExecutor(lease.main_directory, mainGrant).readFile(output.path);
      if (!hashesEqual(current.contentHash, context.content_hash)) throw new Error("Main target preimage no longer matches the approved TaskPackage manifest");
      preimage = current.contentHash;
    }
    return [{ path: output.path, preimage_hash: preimage, postimage_hash: output.contentHash, replacement: output.content }];
  }

  private async mainApplyGrant(record: CoreRecord, targets: ApplyTarget[]): Promise<ExecutorCapabilityGrant> {
    const existing = targets.filter(target => target.preimage_hash !== null).map(target => target.path);
    if (existing.length) return buildExecutorCapabilityGrant(this.projectDirectory, existing, record.route_binding.write_scope, record.task_package.data_classification);
    return { readManifest: [], writeScope: [...record.route_binding.write_scope], maxFileBytes: DEFAULT_EXECUTOR_FILE_LIMIT };
  }

  private async loadRecord(taskId: string): Promise<CoreRecord> { const value = await this.store.load(taskId); assertCoreRecord(value); return value; }
  private async tryLoadRecord(taskId: string): Promise<CoreRecord | undefined> { const value = await this.store.tryLoad(taskId); if (value === undefined) return undefined; assertCoreRecord(value); return value; }
  private async saveRecord(record: CoreRecord): Promise<void> { assertCoreRecord(record); await this.store.save(record.task_package.task_id, record); }
  private async waitForStatus(taskId: string): Promise<RouterCompactStatus> {
    for (let attempt = 0; attempt < 200; attempt++) { try { return await this.status(taskId); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; await delay(5); } }
    throw new ExecutionBusyError();
  }
}

function normalizeTaskPackage(value: TaskPackage | TaskPackageInput): TaskPackage {
  if (value && typeof value === "object" && "task_package_hash" in value) {
    assertTaskPackage(value);
    const { task_package_hash: _hash, ...body } = value;
    return createTaskPackage(body);
  }
  return createTaskPackage(value as TaskPackageInput);
}

function subject(record: CoreRecord) { return { taskPackage: record.task_package, routeBinding: record.route_binding, executionContext: record.execution_context, effectivePolicy: record.effective_policy }; }
function runIdFor(task: TaskPackage): string { return `run-${stableHash({ task_id: task.task_id, task_package_hash: task.task_package_hash }).slice(0, 24)}`; }
function preApprovalHashFor(task: TaskPackage): string { return stableHash({ task_id: task.task_id, task_package_hash: task.task_package_hash, authority: "canonical-preapproval" }); }
function approvalIdFor(taskId: string, executionContextHash: string): string { return `approval-${stableHash({ task_id: taskId, execution_context_hash: executionContextHash, authority: "exact-informed-approval" }).slice(0, 24)}`; }

function qualityGateRequestFor(task: TaskPackage, route: RouteBinding, context: ExecutionContext, worktree: WorktreeBinding, policy: QualityGatePolicy, catalogHash: string, fixtureHash: string, hiddenRootHash: string | null, approvalHash: string): QualityGateRequest {
  return {
    run_id: context.run_id, task_id: task.task_id, base_commit: context.base_commit,
    plan_hash: task.task_package_hash, approval_hash: approvalHash, isolation_hash: worktree.isolation_hash,
    worktree_id: context.worktree_id, write_scope: [...route.write_scope], command_ids: [...policy.command_ids],
    policy_hash: policy.policy_hash, catalog_hash: catalogHash, fixture_hash: fixtureHash, hidden_root_hash: hiddenRootHash,
    effective_policy_hash: context.policy_hash, max_wall_time_ms: policy.max_wall_time_ms,
  };
}

function fallbackAcceptanceProjection(report: QualityGateReport, fixtureHash: string): QualityAcceptanceProjection {
  const outcomes = new Map(report.quality_gate_results.map(item => [item.gate_id, item.outcome]));
  const visible = ["format_check", "lint", "typecheck", "unit_tests", "build"].reduce((counts, id) => { const outcome = outcomes.get(id); if (outcome === "passed") counts.passed++; else if (outcome === "failed") counts.failed++; else if (outcome === "not_run") counts.not_run++; return counts; }, { passed: 0, failed: 0, not_run: 0 });
  const body = {
    version: 1 as const, approval_boundary_hash: report.approval_boundary_hash, quality_report_hash: report.report_hash,
    fixture_hash: fixtureHash, base_commit: report.base_commit,
    visible_tests: visible, hidden_tests: report.hidden_acceptance_result?.counts ?? { passed: 0, failed: 0, not_run: 1 },
    regression: true, scope_passed: report.scope_violations.length === 0, secret_passed: report.secret_scan_summary.outcome === "passed",
    diff_passed: report.quality_gate_results.find(item => item.gate_id === "diff_sanity")?.outcome === "passed",
    freeze_passed: report.quality_gate_results.find(item => item.gate_id === "final_freeze")?.outcome === "passed",
  };
  return { ...body, result_hash: stableHash(body) };
}

function routeDecision(binding: RouteBinding, stage: "EXECUTE" | "REPAIR"): RouteDecision {
  return {
    stage, provider: binding.provider_id, model: binding.model_id, effort: binding.reasoning_effort,
    maxOutputTokens: binding.request_budget.max_output_tokens, maxToolTurns: binding.request_budget.max_tool_calls,
    timeoutMs: binding.request_budget.max_request_wall_time_ms, maxRepairs: 1, mayEscalate: false,
    reason: stage === "EXECUTE" ? "canonical TaskPackage execution" : "single controlled repair under unchanged approval", requiresApproval: true,
  };
}

function localRouteDecision(timeoutMs: number): RouteDecision {
  return { stage: "VALIDATE", provider: "local", model: "local-quality-gates", effort: "none", maxOutputTokens: 1, maxToolTurns: 0, timeoutMs, maxRepairs: 0, mayEscalate: false, reason: "approved local quality gate", requiresApproval: false };
}

function sensitivityFor(task: TaskPackage): "normal" | "private" | "restricted" { return task.data_classification === "public" ? "normal" : task.data_classification === "private" ? "private" : "restricted"; }

function attemptRequest(record: CoreRecord, request: ProviderRequest, initial: WorkflowState, start: WorkflowState, success: WorkflowState, round = 0): AttemptExecutionRequest {
  return {
    task_id: record.task_package.task_id, run_id: record.execution_context.run_id, approval_hash: record.approval_record!.approval_hash,
    stage: request.stage, round, request_fingerprint: providerRequestFingerprint(request),
    initial_workflow_state: initial, start_workflow_state: start, success_workflow_state: success,
  };
}

function assertProviderResponse(request: ProviderRequest, response: ProviderResponse): void {
  if (!response.text || response.provider !== request.route.provider || response.model !== request.route.model || !response.requestId) throw new Error("Provider response identity was incomplete");
  if (!Array.isArray(response.transportRounds) || response.transportRounds.length === 0) throw new Error("Canonical provider transport-round evidence was unavailable");
  assertProviderRouteEvidence(request, response);
}

function verifiedMetadata(response: ProviderResponse) {
  if (!response.requestId) throw new Error("Provider request ID was unavailable");
  return {
    complete: true as const, provider_request_id: response.requestId, response_model: response.model, response_origin: response.routeEvidence?.actualOrigin ?? "local",
    usage: { input_tokens: response.usage.inputTokens, output_tokens: response.usage.outputTokens, reasoning_tokens: response.usage.reasoningTokens, cached_input_tokens: response.usage.cachedInputTokens, cache_write_tokens: response.usage.cacheWriteTokens, cache_hit_tokens: response.usage.cacheHitTokens, cache_miss_tokens: response.usage.cacheMissTokens },
    transport_rounds: response.transportRounds ?? [], provider_reported_cost_usd: response.providerReportedCostUsd ?? null, estimated_list_cost_usd: response.estimatedListCostUsd ?? null,
  };
}

function sumCosts(values: number[]): number { return Math.round(values.reduce((total, value) => total + value, 0) * 1e12) / 1e12; }
function sumRoundWall(rounds: Array<{ wall_clock_time_ms: number | null }>): number { return rounds.reduce((total, round) => total + (round.wall_clock_time_ms ?? 0), 0); }

function nextAction(state: WorkflowState, hasEvidence: boolean): RouterCompactStatus["next"] {
  if (state === "AWAITING_APPROVAL") return "execute";
  if (state === "REVIEW_PENDING" && hasEvidence) return "review_evidence";
  if (state === "REVIEW_PENDING") return "status";
  if (state === "REPAIR_REQUIRED") return "repair";
  if (state === "APPLY_PENDING") return "apply";
  if (["PASSED", "BLOCKED", "ABORTED"].includes(state)) return "none";
  return "status";
}

function assertCoreRecord(value: unknown): asserts value is CoreRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Router core record");
  const record = value as CoreRecord;
  const keys = ["version", "task_package", "effective_policy", "route_binding", "execution_context", "worktree_binding", "approval_record", "execution_evidence", "evidence_bundle_hash", "evidence_bundle_reference", "quality_summary", "final_review", "review_history", "repair_count", "apply_record", "quality_boundary", "fixture_hash", "hidden_root_hash", "pilot_record_hash", "pilot_record_reference", "created_at", "updated_at"];
  if (Object.keys(record).length !== keys.length || keys.some(key => !(key in record)) || record.version !== 1) throw new Error("Router core record has unknown or missing fields");
  assertTaskPackage(record.task_package); assertEffectivePolicy(record.effective_policy); assertRouteBinding(record.route_binding); assertExecutionContext(record.execution_context);
  assertWorktreeBinding(record.worktree_binding);
  if (record.execution_context.task_id !== record.task_package.task_id || record.execution_context.run_id !== record.worktree_binding.run_id || record.execution_context.worktree_id !== record.worktree_binding.worktree_id || record.execution_context.base_commit !== record.worktree_binding.base_commit || record.execution_context.main_workspace_snapshot !== record.worktree_binding.main_workspace_snapshot || record.execution_context.task_package_hash !== record.task_package.task_package_hash || record.execution_context.route_binding_hash !== record.route_binding.route_binding_hash || record.execution_context.policy_hash !== record.effective_policy.policy_hash) throw new Error("Router core contract bindings are inconsistent");
  if (record.approval_record !== null) { assertApprovalRecord(record.approval_record); assertContractApproval(subject(record), record.approval_record); }
  if (record.execution_evidence !== null) assertExecutionEvidence(record.execution_evidence);
  assertHash(record.fixture_hash, "fixture hash");
  if (record.hidden_root_hash !== null) assertHash(record.hidden_root_hash, "hidden root hash");
  if (record.quality_boundary !== null) {
    assertQualityGateApprovalBoundary(record.quality_boundary);
    if (record.quality_boundary.run_id !== record.execution_context.run_id || record.quality_boundary.task_id !== record.task_package.task_id || record.quality_boundary.worktree_id !== record.worktree_binding.worktree_id || record.quality_boundary.base_commit !== record.execution_context.base_commit || record.quality_boundary.fixture_hash !== record.fixture_hash || record.quality_boundary.hidden_root_hash !== record.hidden_root_hash) throw new Error("Router quality approval boundary is not bound to the core record");
  }
  if ((record.pilot_record_hash === null) !== (record.pilot_record_reference === null)) throw new Error("Router pilot record hash/reference must be persisted together");
  if (record.pilot_record_hash !== null) {
    assertHash(record.pilot_record_hash, "pilot record hash");
    if (!record.evidence_bundle_hash || record.pilot_record_reference !== `tasks/${record.task_package.task_id}/pilot-runs/${record.execution_context.run_id}.json`) throw new Error("Router pilot record is outside the current task/run namespace");
  }
  if ((record.evidence_bundle_hash === null) !== (record.evidence_bundle_reference === null) || (record.evidence_bundle_hash !== null && !HASH.test(record.evidence_bundle_hash))) throw new Error("Router core evidence reference is invalid");
  if (record.evidence_bundle_reference !== null && (!record.evidence_bundle_reference.startsWith(`evidence/${record.execution_context.run_id}/`) || record.evidence_bundle_reference.includes("\\"))) throw new Error("Router core evidence reference is outside the run namespace");
  if (record.quality_summary !== null && (!Array.isArray(record.quality_summary.files_changed) || !Array.isArray(record.quality_summary.gate_failures) || typeof record.quality_summary.quality_passed !== "boolean")) throw new Error("Router core quality summary is invalid");
  if (!Array.isArray(record.review_history)) throw new Error("Router core review history is invalid");
  record.review_history.forEach(assertFinalReview);
  if (record.final_review !== null) {
    assertFinalReview(record.final_review);
    if (!record.evidence_bundle_hash || record.final_review.evidence_bundle_hash !== record.evidence_bundle_hash) throw new Error("Router core final review is not current");
  }
  if (!Number.isInteger(record.repair_count) || record.repair_count < 0 || record.repair_count > 1) throw new Error("Router core repair count is invalid");
  if (record.apply_record !== null) {
    const apply = record.apply_record;
    const applyKeys = ["status", "evidence_bundle_hash", "diff_hash", "targets", "prepared_at", "applied_at"];
    if (Object.keys(apply).length !== applyKeys.length || applyKeys.some(key => !(key in apply)) || !["PREPARED", "APPLIED"].includes(apply.status) || !HASH.test(apply.evidence_bundle_hash) || !HASH.test(apply.diff_hash) || !Array.isArray(apply.targets) || apply.targets.length !== 1) throw new Error("Router core apply record is invalid");
    apply.targets.forEach(target => { const targetKeys = ["path", "preimage_hash", "postimage_hash"]; if (Object.keys(target).length !== targetKeys.length || targetKeys.some(key => !(key in target))) throw new Error("Router core apply target is invalid"); assertSafeRelativePath(target.path, "apply target path"); if (target.preimage_hash !== null && !HASH.test(target.preimage_hash)) throw new Error("Router apply preimage is invalid"); if (!HASH.test(target.postimage_hash)) throw new Error("Router apply postimage is invalid"); });
    assertTimestamp(apply.prepared_at); if (apply.applied_at !== null) assertTimestamp(apply.applied_at);
    if ((apply.status === "APPLIED") !== (apply.applied_at !== null) || apply.evidence_bundle_hash !== record.evidence_bundle_hash || record.final_review?.decision !== "PASS") throw new Error("Router apply record binding is invalid");
  }
  assertTimestamp(record.created_at); assertTimestamp(record.updated_at);
}

function assertWorktreeBinding(value: WorktreeBinding): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid worktree binding");
  const keys = ["run_id", "worktree_id", "repository_id", "base_commit", "main_workspace_snapshot", "main_workspace_dirty_evidence", "plan_hash", "isolation_hash"];
  if (Object.keys(value).length !== keys.length || keys.some(key => !(key in value))) throw new Error("Invalid worktree binding fields");
  for (const hash of [value.repository_id, value.main_workspace_snapshot, value.plan_hash, value.isolation_hash]) assertHash(hash, "worktree binding hash");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.run_id) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.worktree_id) || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value.base_commit) || !Array.isArray(value.main_workspace_dirty_evidence)) throw new Error("Invalid worktree binding identity");
  const { isolation_hash: _hash, ...body } = value;
  if (!hashesEqual(value.isolation_hash, stableHash(body))) throw new Error("Worktree isolation hash changed");
}

function assertExecutionEvidence(value: CoreExecutionEvidence): void {
  if (!value || Object.keys(value).length !== 7 || !value.attempt_id || !value.provider_request_id || !value.response_model || !value.response_origin || [value.input_tokens, value.output_tokens, value.reasoning_tokens].some(item => !Number.isInteger(item) || item < 0)) throw new Error("Router execution evidence is invalid");
}
function assertFinalReview(value: CoreRecord["review_history"][number]): void {
  if (!value || !["PASS", "REPAIR_REQUIRED", "BLOCKED"].includes(value.decision) || !HASH.test(value.evidence_bundle_hash)) throw new Error("Router core final review is invalid");
  assertReviewSummary(value.summary); assertTimestamp(value.reviewed_at);
}
function assertReviewSummary(value: string): void { if (typeof value !== "string" || value.length < 1 || value.length > 2_000 || /\r|\0/.test(value) || containsSecretLikeText(value)) throw new Error("Final review summary must be concise safe text"); }
function assertHash(value: string, name: string): void { if (typeof value !== "string" || !HASH.test(value)) throw new Error(`Invalid ${name}`); }
function assertTimestamp(value: string): void { if (typeof value !== "string" || Number.isNaN(Date.parse(value))) throw new Error("Invalid Router timestamp"); }
function rootsOverlap(left: string, right: string): boolean { const relativeLeft = path.relative(left, right); const relativeRight = path.relative(right, left); return relativeLeft === "" || (!relativeLeft.startsWith("..") && !path.isAbsolute(relativeLeft)) || (!relativeRight.startsWith("..") && !path.isAbsolute(relativeRight)); }
