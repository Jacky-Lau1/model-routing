import { randomUUID } from "node:crypto";
import path from "node:path";
import { DurableAttemptExecutor, type AttemptExecutionRequest } from "./attempt-executor.js";
import { AttemptPersistence } from "./attempt-persistence.js";
import { approvePlan, assertApproval } from "./approval.js";
import { stableHash } from "./canonical.js";
import { classifyTask } from "./classifier.js";
import { assertRouteBinding, createEvidenceBundle } from "./contracts.js";
import { buildPrompt } from "./context.js";
import { estimateEquivalentUsd, pricingCatalogEvidence, PRICING_CATALOG_VERSION } from "./cost.js";
import { StateStore, transitionState } from "./persistence.js";
import { decideRoute } from "./policy.js";
import { assertProviderRouteEvidence, providerRequestFingerprint } from "./provider-evidence.js";
import { redactError } from "./redaction.js";
import { DEFAULT_QUALITY_GATE_POLICY, assertQualityGatePolicy, assertQualityGateReportForRequest, persistEvidenceBundle, readEvidenceArtifact } from "./quality-gate.js";
import { adapterIdFor, buildLegacyRouteBinding, freezeRouteBinding, preflightRouteBinding } from "./route-preflight.js";
import { applyStructuredPatches, buildExecutorCapabilityGrant } from "./safe-executor.js";
import { assertLegacyTransition, canLegacyTransition } from "./state-machine.js";
import { assertAllowedChanges, hashScopeSnapshot, snapshotWorkingTree } from "./scope-guard.js";
import { GitWorktreeManager, type WorktreeLease } from "./worktree.js";
import type { DataClassification, EvidenceBundle, LegacyWorkflowState, PlanPacket, ProviderAdapter, ProviderRequest, ProviderResponse, QualityGatePolicy, QualityGateReport, RouteDecision, RunState, TaskProfile, UsageAvailability, UsageMetrics, WorkflowState } from "./types.js";

export interface AutoOptions {
  projectDirectory?: string;
  profile?: Partial<TaskProfile>;
  taskId?: string;
}

interface DraftPlan { nonGoals?: string[]; steps: string[]; readFiles: string[]; writeFiles: string[]; dataClassification: DataClassification; constraints: string[]; acceptance: string[]; validationCommands?: string[] }
interface Review { verdict: "pass" | "repair" | "escalate"; findings?: string[]; summary?: string; finalText?: string }

export class RouterOrchestrator {
  private readonly attempts: DurableAttemptExecutor;
  private readonly worktrees: GitWorktreeManager;

  constructor(
    private readonly modelAdapter: ProviderAdapter,
    private readonly localAdapter: ProviderAdapter,
    readonly store = new StateStore(),
    attempts?: DurableAttemptExecutor,
    worktrees?: GitWorktreeManager,
    private readonly qualityPolicy: QualityGatePolicy = DEFAULT_QUALITY_GATE_POLICY,
  ) {
    assertQualityGatePolicy(this.qualityPolicy);
    this.attempts = attempts ?? new DurableAttemptExecutor(new AttemptPersistence(this.store.root));
    this.worktrees = worktrees ?? new GitWorktreeManager({ stateRoot: this.store.root });
  }

  async auto(objective: string, options: AutoOptions = {}): Promise<RunState> {
    await this.worktrees.assertIsolationRoots(options.projectDirectory ?? process.cwd());
    const taskId = options.taskId ?? `task-${randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    const profile = classifyTask(objective, options.profile);
    let state: RunState = { version: 1, taskId, state: "INTAKE", profile, attempts: 0, repairAttempts: 0, createdAt: now, updatedAt: now };
    state = move(state, "PROFILED"); state = move(state, "PLANNING");
    await this.store.save(state, true);
    const planningStage = profile.kind === "text" ? "TEXT_FRAME" : "PLAN";
    const planningRoute = decideRoute(planningStage, profile);
    const prompt = buildPrompt(planningStage,
      "Create a decision-complete bounded plan. Do not execute or modify files. JSON only.",
      PLAN_SCHEMA, projectSummary(options.projectDirectory), objective, profile.sensitivity);
    const providerRequest = { stage: planningStage, route: planningRoute, ...prompt, sensitivity: profile.sensitivity, workingDirectory: options.projectDirectory } satisfies ProviderRequest;
    const priorPlanning = (await this.attempts.status(taskId)).attempts.filter(item => item.stage === planningStage).length;
    let draft: DraftPlan | undefined;
    let response: ProviderResponse | undefined;
    try {
      response = await this.invokeTracked(state, this.modelAdapter, providerRequest, {
        approvalHash: preApprovalHash(taskId), round: priorPlanning,
        initial: "CREATED", start: "PLANNING", success: "AWAITING_APPROVAL",
        validate: result => { draft = parseJson<DraftPlan>(result.text); validateDraftPlan(draft); },
      });
    } catch (error) {
      state = { ...move(state, "BLOCKED"), lastError: redactError(error) };
      await this.store.save(state, true); return state;
    }
    if (!response || !draft) return this.store.load(taskId);
    const executionStage = profile.kind === "text" ? "TEXT_EXPAND" : "EXECUTE";
    const readFiles = requiredArray(draft.readFiles, "readFiles");
    const writeFiles = requiredArray(draft.writeFiles, "writeFiles");
    const executionRoute = decideRoute(executionStage, profile);
    const plan: PlanPacket = {
      version: 1, taskId, objective, nonGoals: draft.nonGoals ?? [], steps: requiredArray(draft.steps, "steps"),
      readFiles, writeFiles,
      dataClassification: draft.dataClassification, allowedFiles: [...writeFiles], constraints: draft.constraints ?? [],
      acceptance: requiredArray(draft.acceptance, "acceptance"), validationCommands: [...this.qualityPolicy.command_ids], qualityPolicyHash: this.qualityPolicy.policy_hash,
      route: executionRoute, routeBinding: buildLegacyRouteBinding(executionRoute, readFiles, writeFiles),
    };
    state = addResponse({ ...state, plan }, planningRoute, response);
    state = move(state, "WAITING_APPROVAL");
    await this.store.save(state, true);
    return state;
  }

  async revise(taskId: string, instruction: string, projectDirectory?: string): Promise<RunState> {
    const prior = await this.store.load(taskId);
    if (!prior.plan) throw new Error("No plan to revise");
    const objective = `${prior.plan.objective}\n\nREVISION_REQUEST\n${instruction}`;
    return this.auto(objective, { taskId, projectDirectory, profile: prior.profile });
  }

  async approve(taskId: string, projectDirectory = process.cwd()): Promise<RunState> {
    await this.worktrees.assertIsolationRoots(projectDirectory);
    let state = await this.store.load(taskId);
    if (state.state !== "WAITING_APPROVAL" && state.state !== "WAITING_REAPPROVAL") return state;
    if (!state.plan) throw new Error("Task has no plan");
    const plan = state.plan;
    assertRouteBinding(plan.routeBinding);
    const runId = runIdFor(taskId);
    let approvalHash: string | undefined;
    let lease: WorktreeLease | undefined;
    try {
      const baseline = await this.worktrees.captureMainWorkspace(projectDirectory);
      const binding = this.worktrees.createBinding(runId, stableHash(plan), baseline);
      state = { ...state, approval: approvePlan(plan, binding.isolation_hash) };
      assertApproval(plan, state.approval, binding.isolation_hash);
      approvalHash = executionApprovalHash(plan, binding.isolation_hash);
      const releaseHandoff = await this.attempts.tryAcquireWorktreeHandoffLock(taskId, approvalHash);
      if (!releaseHandoff) return this.store.load(taskId);
      try {
        const approvalWorkflow = await this.attempts.bindApproval(taskId, runId, preApprovalHash(taskId), approvalHash);
        if (!["APPROVED", "WORKTREE_READY"].includes(approvalWorkflow.state)) return this.store.load(taskId);
        lease = await this.worktrees.prepare(projectDirectory, binding);
        const worktreeWorkflow = await this.attempts.markWorktreeReady(taskId, runId, approvalHash);
        if (worktreeWorkflow.state !== "WORKTREE_READY") return this.store.load(taskId);
        state = move(state, "EXECUTING");
        await this.store.save(state, true);
      } finally { await releaseHandoff().catch(() => undefined); }
      const isolatedDirectory = lease.checkout_directory;
      const scopeBefore = await snapshotWorkingTree(isolatedDirectory);
      const execution = await this.invokeExecution(state, plan.route, isolatedDirectory, "Perform only the approved plan. Respect allowed files and stop conditions.");
      if (!execution) throw new Error("Execution attempt did not produce a reusable response; inspect the durable attempt before any retry");
      const scopeAfter = await snapshotWorkingTree(isolatedDirectory);
      assertAllowedChanges(scopeBefore, scopeAfter, plan.writeFiles);
      state = addResponse({ ...state, attempts: state.attempts + 1, result: execution.text }, plan.route, execution);
      state = move(state, "VALIDATING"); await this.store.save(state);
      let validation = await this.validate(state, lease);
      if (validation.response && validation.route) state = addResponse(state, validation.route, validation.response);
      if (validation.bundle && validation.bundleReference) state = { ...state, evidenceBundleHash: validation.bundle.bundle_hash, evidenceBundleReference: validation.bundleReference };
      await this.store.save(state, true);
      if (!validation.passed) {
        if (validation.securityBlocked) throw new Error("Quality gate security or evidence boundary failed");
        state = await this.repairOrDiagnose(state, isolatedDirectory, validation.text);
        if (state.state === "WAITING_REAPPROVAL" || state.state === "BLOCKED") return state;
        validation = await this.validate(state, lease);
        if (validation.response && validation.route) state = addResponse(state, validation.route, validation.response);
        if (validation.bundle && validation.bundleReference) state = { ...state, evidenceBundleHash: validation.bundle.bundle_hash, evidenceBundleReference: validation.bundleReference };
        await this.store.save(state, true);
        if (!validation.passed) { if (validation.securityBlocked) throw new Error("Quality gate security or evidence boundary failed"); return this.diagnose(state, isolatedDirectory, validation.text); }
      }
      state = move(state, "REVIEWING"); await this.store.save(state);
      const reviewResult = await this.review(state, isolatedDirectory, validation.text);
      state = addResponse(state, reviewResult.route, reviewResult.response);
      if (reviewResult.review.verdict === "pass") { await this.worktrees.assertMainWorkspaceUnchanged(lease); await this.worktrees.retain(lease); state = { ...move(state, "COMPLETED"), result: reviewResult.review.finalText ?? reviewResult.review.summary ?? state.result }; await this.store.save(state, true); return state; }
      if (reviewResult.review.verdict === "repair" && state.repairAttempts === 0) {
        state = await this.repairOrDiagnose(state, isolatedDirectory, JSON.stringify(reviewResult.review));
        if (state.state === "WAITING_REAPPROVAL" || state.state === "BLOCKED") return state;
        const repairedValidation = await this.validate(state, lease);
        if (repairedValidation.response && repairedValidation.route) state = addResponse(state, repairedValidation.route, repairedValidation.response);
        if (repairedValidation.bundle && repairedValidation.bundleReference) state = { ...state, evidenceBundleHash: repairedValidation.bundle.bundle_hash, evidenceBundleReference: repairedValidation.bundleReference };
        await this.store.save(state, true);
        if (!repairedValidation.passed) { if (repairedValidation.securityBlocked) throw new Error("Quality gate security or evidence boundary failed"); return this.diagnose(state, isolatedDirectory, repairedValidation.text); }
        state = move(state, "REVIEWING");
        const finalReview = await this.review(state, isolatedDirectory, repairedValidation.text);
        state = addResponse(state, finalReview.route, finalReview.response);
        if (finalReview.review.verdict === "pass") { await this.worktrees.assertMainWorkspaceUnchanged(lease); await this.worktrees.retain(lease); state = { ...move(state, "COMPLETED"), result: finalReview.review.finalText ?? finalReview.review.summary ?? state.result }; await this.store.save(state, true); return state; }
      }
      return this.diagnose(state, isolatedDirectory, JSON.stringify(reviewResult.review));
    } catch (error) {
      if (approvalHash) await this.attempts.blockLocalFailure(taskId, runId, approvalHash, error).catch(() => undefined);
      const latest = await this.store.load(taskId).catch(() => state);
      if (latest.state === "BLOCKED" || !canLegacyTransition(latest.state, "BLOCKED")) return latest;
      const blocked = { ...move(latest, "BLOCKED"), lastError: redactError(error) };
      await this.store.save(blocked, true); return blocked;
    }
  }

  async abort(taskId: string): Promise<RunState> {
    const state = move(await this.store.load(taskId), "ABORTED"); await this.store.save(state, true); return state;
  }

  private async invokeExecution(state: RunState, route: RouteDecision, projectDirectory: string, instruction: string): Promise<ProviderResponse | undefined> {
    if (!state.plan || !state.approval) throw new Error("Missing plan or approval"); assertApproval(state.plan, state.approval, state.approval.isolationHash);
    const routeBinding = freezeRouteBinding(state.plan.routeBinding);
    if (route.provider === "deepseek" && state.plan.dataClassification !== "public") throw new Error("Legacy DeepSeek execution requires an explicitly approved public classification");
    const codeExecution = route.stage === "EXECUTE" || route.stage === "REPAIR";
    const prompt = buildPrompt(route.stage, instruction, "Return a concise execution summary and evidence.", JSON.stringify({ readFiles: state.plan.readFiles, writeFiles: state.plan.writeFiles, constraints: state.plan.constraints }), JSON.stringify(state.plan), state.profile.sensitivity);
    const executorCapabilities = route.provider === "deepseek" && codeExecution
      ? await buildExecutorCapabilityGrant(projectDirectory, state.plan.readFiles, state.plan.writeFiles, state.plan.dataClassification)
      : undefined;
    const request = { stage: route.stage, route, routeBinding, ...prompt, sensitivity: state.profile.sensitivity, workingDirectory: projectDirectory, allowedFiles: state.plan.writeFiles, executorCapabilities } satisfies ProviderRequest;
    const tracked = route.stage === "REPAIR" ? this.attempts.repair.bind(this.attempts) : this.attempts.execute.bind(this.attempts);
    return this.invokeTracked(state, this.modelAdapter, request, {
      approvalHash: executionApprovalHash(state.plan, state.approval.isolationHash), round: route.stage === "REPAIR" ? state.repairAttempts + 1 : 0,
      initial: route.stage === "REPAIR" ? "REPAIR_REQUIRED" : "WORKTREE_READY", start: "EXECUTING", success: "VALIDATING", tracked,
      validate: async response => {
        if (route.provider !== "deepseek" || !codeExecution) return;
        if (!executorCapabilities || !Array.isArray(response.structuredPatches) || response.structuredPatches.length !== 1) throw new Error("DeepSeek code execution requires exactly one structured patch proposal");
        // Apply only after a complete provider response is available, but
        // before SUCCEEDED is persisted. A crash or local apply failure remains
        // AMBIGUOUS/BLOCKED and can never trigger an automatic resend.
        await applyStructuredPatches(projectDirectory, executorCapabilities, response.structuredPatches);
      },
    });
  }

  private async validate(state: RunState, lease: WorktreeLease): Promise<{ passed: boolean; securityBlocked?: boolean; text: string; route?: RouteDecision; response?: ProviderResponse; bundle?: EvidenceBundle; bundleReference?: string }> {
    if (!state.plan || !state.approval) throw new Error("Quality validation requires an approved plan");
    if (state.plan.qualityPolicyHash !== this.qualityPolicy.policy_hash) throw new Error("Quality policy changed after approval");
    const projectDirectory = lease.checkout_directory;
    const effectivePolicyHash = legacyEffectivePolicyHash(state.plan, this.qualityPolicy);
    const approvalHash = executionApprovalHash(state.plan, state.approval.isolationHash);
    const route = decideRoute("VALIDATE", state.profile);
    const request = {
      stage: "VALIDATE" as const, route, stablePrefix: "", projectSummary: "", dynamicInput: "structured-quality-gate", sensitivity: state.profile.sensitivity, workingDirectory: projectDirectory,
      qualityGate: {
        run_id: lease.binding.run_id, task_id: state.taskId, base_commit: lease.binding.base_commit, plan_hash: stableHash(state.plan), approval_hash: approvalHash,
        isolation_hash: lease.binding.isolation_hash, worktree_id: lease.binding.worktree_id, write_scope: [...state.plan.writeFiles], command_ids: [...this.qualityPolicy.command_ids],
        policy_hash: this.qualityPolicy.policy_hash, catalog_hash: this.qualityPolicy.command_registry_hash,
        fixture_hash: stableHash({ provenance: "legacy_bridge", project: lease.binding.repository_id }), hidden_root_hash: null,
        effective_policy_hash: effectivePolicyHash, max_wall_time_ms: this.qualityPolicy.max_wall_time_ms,
      },
    } satisfies ProviderRequest;
    let parsed: QualityGateReport | undefined;
    const response = await this.invokeTracked(state, this.localAdapter, request, {
      approvalHash, round: state.repairAttempts,
      initial: "VALIDATING", start: "VALIDATING", success: "REVIEW_PENDING",
      validate: result => { const value = JSON.parse(result.text) as QualityGateReport; assertQualityGateReportForRequest(value, request.qualityGate!); parsed = value; },
    });
    if (!response || !parsed) return { passed: false, text: JSON.stringify({ passed: false, blocked: "existing attempt" }) };
    const beforeBundle = parsed.passed ? await snapshotWorkingTree(projectDirectory) : undefined;
    if (beforeBundle) {
      const trackedChanged = [...beforeBundle.keys()].sort();
      if (trackedChanged.join("\0") !== parsed.files_changed.join("\0") || hashScopeSnapshot(beforeBundle) !== parsed.worktree_snapshot_hash) throw new Error("Quality report did not match the frozen worktree content");
    }
    await readEvidenceArtifact(this.store.root, parsed.diff_reference, parsed.diff_hash);
    const bundle = await this.createBundle(state, lease, parsed, response, approvalHash, effectivePolicyHash);
    const bundleReference = await persistEvidenceBundle(this.store.root, bundle);
    if (beforeBundle) {
      const afterBundle = await snapshotWorkingTree(projectDirectory);
      if (stableHash([...beforeBundle]) !== stableHash([...afterBundle])) throw new Error("Worktree changed while EvidenceBundle was being persisted");
    }
    return { passed: parsed.passed, securityBlocked: qualitySecurityBlocked(parsed), text: JSON.stringify(bundle), route, response, bundle, bundleReference };
  }

  private async createBundle(state: RunState, lease: WorktreeLease, report: QualityGateReport, localResponse: ProviderResponse, approvalHash: string, effectivePolicyHash: string): Promise<EvidenceBundle> {
    const attempts = (await this.attempts.status(state.taskId)).attempts;
    const combinedEvidence = [...(state.routeEvidence ?? []), evidence(decideRoute("VALIDATE", state.profile), localResponse)];
    const routeEvidenceIds = combinedEvidence.map((item, index) => `route-${stableHash({ item, occurrence: index }).slice(0, 24)}`);
    const usage = state.usage;
    const availability = state.usageAvailability ?? { inputTokens: true, outputTokens: true, reasoningTokens: true, cacheHitTokens: true, cacheMissTokens: true };
    const taskProjectionHash = stableHash(state.plan);
    const executionContextHash = stableHash({ provenance: "legacy_bridge", run_id: lease.binding.run_id, task_id: state.taskId, base_commit: lease.binding.base_commit, worktree_id: lease.binding.worktree_id, isolation_hash: lease.binding.isolation_hash, approval_hash: approvalHash });
    const transportRounds = attempts.flatMap(item => item.transport_rounds);
    const modelAttempts = attempts.filter(item => item.stage === "EXECUTE" || item.stage === "REPAIR");
    const modelRounds = modelAttempts.flatMap(item => item.transport_rounds);
    const roundEstimated = modelRounds.length && modelRounds.every(item => item.estimated_list_cost_usd !== null) ? sumLegacyCosts(modelRounds.map(item => item.estimated_list_cost_usd!)) : null;
    const estimated = roundEstimated ?? (modelRounds.length === 0 ? state.normalizedEquivalentUsd ?? null : null);
    const providerReported = modelRounds.length && modelRounds.every(item => item.provider_reported_cost_usd !== null) ? sumLegacyCosts(modelRounds.map(item => item.provider_reported_cost_usd!)) : null;
    const pricedBands = modelRounds.map(item => item.pricing_time_band).filter((item): item is NonNullable<typeof item> => item !== null);
    const executeWall = sumLegacyRoundWall(modelAttempts.filter(item => item.stage === "EXECUTE").flatMap(item => item.transport_rounds));
    const repairWall = sumLegacyRoundWall(modelAttempts.filter(item => item.stage === "REPAIR").flatMap(item => item.transport_rounds));
    const visible = { passed: 0, failed: 0, not_run: 0 };
    for (const id of this.qualityPolicy.command_ids) {
      if (id === "project_acceptance") continue;
      const outcome = report.quality_gate_results.find(item => item.gate_id === id)?.outcome;
      if (outcome === "passed") visible.passed += 1;
      else if (outcome === "failed") visible.failed += 1;
      else visible.not_run += 1;
    }
    const acceptanceBody = {
      version: 1 as const, approval_boundary_hash: report.approval_boundary_hash, quality_report_hash: report.report_hash,
      fixture_hash: report.fixture_hash, base_commit: report.base_commit, visible_tests: visible, hidden_tests: { passed: 0, failed: 0, not_run: 1 },
      regression: true, scope_passed: report.scope_violations.length === 0, secret_passed: report.secret_scan_summary.outcome === "passed" && report.secret_scan_summary.new_findings === 0,
      diff_passed: report.quality_gate_results.find(item => item.gate_id === "diff_sanity")?.outcome === "passed" && report.quality_gate_results.find(item => item.gate_id === "evidence_artifact")?.outcome === "passed",
      freeze_passed: report.quality_gate_results.find(item => item.gate_id === "final_freeze")?.outcome === "passed" && report.content_snapshot_hash === report.post_artifact_snapshot_hash,
    };
    const input = {
      version: 4 as const, bundle_id: `bundle-${stableHash({ run: lease.binding.run_id, content: report.content_snapshot_hash, round: state.repairAttempts }).slice(0, 24)}`,
      run_id: lease.binding.run_id, task_id: state.taskId, contract_provenance: "legacy_bridge" as const,
      task_package_hash: taskProjectionHash, route_binding_hash: state.plan!.routeBinding.route_binding_hash, policy_hash: effectivePolicyHash, quality_policy_hash: this.qualityPolicy.policy_hash,
      quality_approval_boundary_hash: report.approval_boundary_hash, quality_catalog_hash: report.catalog_hash, fixture_hash: report.fixture_hash, hidden_root_hash: null,
      acceptance_results: { ...acceptanceBody, result_hash: stableHash(acceptanceBody) }, quality_policy: { ...this.qualityPolicy, command_ids: [...this.qualityPolicy.command_ids] },
      hidden_acceptance_result: null,
      approval_hash: approvalHash, execution_context_hash: executionContextHash, isolation_hash: lease.binding.isolation_hash, worktree_id: lease.binding.worktree_id,
      base_commit: lease.binding.base_commit, worktree_head: report.worktree_head,
      quality_request_hash: report.request_hash, quality_report_hash: report.report_hash, quality_passed: report.passed, quality_write_scope: [...state.plan!.writeFiles], quality_command_ids: [...this.qualityPolicy.command_ids],
      post_artifact_snapshot_hash: report.post_artifact_snapshot_hash, worktree_snapshot_hash: report.worktree_snapshot_hash,
      attempt_ids: attempts.map(item => item.attempt_id), route_evidence_ids: routeEvidenceIds,
      attempt_summaries: attempts.map(item => ({ attempt_id: item.attempt_id, stage: item.stage, status: item.status, failure_class: item.failure_class })),
      route_evidence_summaries: combinedEvidence.map((item, index) => ({ evidence_id: routeEvidenceIds[index], provider: item.actualProvider, model: item.actualModel ?? item.expectedModel, verification_status: item.verificationStatus, request_id_present: item.requestId !== null })),
      transport_rounds: transportRounds,
      files_changed: [...report.files_changed], content_snapshot_hash: report.content_snapshot_hash, diff_hash: report.diff_hash, diff_reference: report.diff_reference,
      quality_gate_results: report.quality_gate_results, tests_run: report.tests_run, scope_violations: report.scope_violations, privacy_violations: report.privacy_violations,
      secret_scan_summary: report.secret_scan_summary, usage_metrics: {
        input_tokens: availability.inputTokens ? usage?.inputTokens ?? null : null, output_tokens: availability.outputTokens ? usage?.outputTokens ?? null : null, reasoning_tokens: availability.reasoningTokens ? usage?.reasoningTokens ?? null : null,
        cached_input_tokens: availability.inputTokens ? usage?.cachedInputTokens ?? null : null, cache_write_tokens: availability.inputTokens ? usage?.cacheWriteTokens ?? null : null,
        cache_hit_tokens: availability.cacheHitTokens ? usage?.cacheHitTokens ?? null : null, cache_miss_tokens: availability.cacheMissTokens ? usage?.cacheMissTokens ?? null : null,
      },
      cost_metrics: { provider_reported_usd: providerReported, estimated_list_usd: estimated, invoice_usd: null, chatgpt_quota: null },
      pricing_catalog: roundEstimated === null ? null : pricingCatalogEvidence(pricedBands), wall_clock_time_ms: report.wall_clock_time_ms,
      stage_wall_clock_ms: { plan: null, execute: executeWall, gate: report.wall_clock_time_ms, review: null, repair: repairWall, total: executeWall + report.wall_clock_time_ms + repairWall },
      repair_count: state.repairAttempts, remaining_risks: ["legacy_bridge_contract_projection", "project_commands_not_os_sandboxed", "secret_scan_is_heuristic", "network_peer_and_proxy_not_observable"],
      redaction_notes: report.redaction_notes,
    };
    return createEvidenceBundle(input);
  }

  private async review(state: RunState, projectDirectory: string, validation: string): Promise<{ review: Review; route: RouteDecision; response: ProviderResponse }> {
    if (!state.plan) throw new Error("Missing plan");
    const stage = state.profile.kind === "visual" ? "VISUAL_REVIEW" : "REVIEW";
    const route = decideRoute(stage, state.profile);
    const reviewInstruction = state.profile.kind === "text"
      ? "Review and compress the expanded text against the frozen plan. Return the polished final text in finalText. JSON only."
      : "Review the current workspace against the frozen plan and evidence. Do not edit files. JSON only.";
    const prompt = buildPrompt(stage, reviewInstruction, REVIEW_SCHEMA, JSON.stringify(state.plan), `${validation}\n\nEXECUTION_RESULT\n${state.result ?? ""}`, state.profile.sensitivity);
    const request = { stage, route, ...prompt, sensitivity: state.profile.sensitivity, workingDirectory: projectDirectory } satisfies ProviderRequest;
    let review: Review | undefined;
    const response = await this.invokeTracked(state, this.modelAdapter, request, {
      approvalHash: executionApprovalHash(state.plan, requiredIsolationHash(state)), round: state.repairAttempts,
      initial: "REVIEW_PENDING", start: "REVIEW_PENDING", success: "REVIEW_PENDING",
      validate: result => { review = parseJson<Review>(result.text); validateReview(review); },
    });
    if (!response || !review) throw new Error("Review attempt already exists without a reusable response body");
    return { review, route, response };
  }

  private async repairOrDiagnose(state: RunState, projectDirectory: string, evidenceText: string): Promise<RunState> {
    if (!state.plan || state.repairAttempts >= 1) return this.diagnose(state, projectDirectory, evidenceText);
    const plan = state.plan;
    if (!state.approval) throw new Error("Legacy repair requires the existing approval");
    const durable = await this.attempts.status(state.taskId);
    if (!durable.workflow) throw new Error("Legacy repair workflow checkpoint is missing");
    if (durable.workflow.state === "REVIEW_PENDING") {
      await this.attempts.finalizeReview(state.taskId, durable.workflow.run_id, executionApprovalHash(plan, state.approval.isolationHash), "REPAIR_REQUIRED", "Legacy quality/review evidence requested the single bounded repair");
    } else if (durable.workflow.state !== "REPAIR_REQUIRED") throw new Error("Legacy repair is not pending an explicit repair decision");
    state = move(state, "REPAIRING");
    const route = decideRoute("REPAIR", state.profile);
    const scopeBefore = await snapshotWorkingTree(projectDirectory);
    const repaired = await this.invokeExecution(state, route, projectDirectory, `Repair once using this evidence:\n${evidenceText}`);
    if (!repaired) return this.store.load(state.taskId);
    const scopeAfter = await snapshotWorkingTree(projectDirectory);
    assertAllowedChanges(scopeBefore, scopeAfter, plan.writeFiles);
    state = addResponse({ ...state, repairAttempts: 1, result: repaired.text }, route, repaired);
    state = move(state, "VALIDATING"); await this.store.save(state); return state;
  }

  private async diagnose(state: RunState, projectDirectory: string, evidenceText: string): Promise<RunState> {
    if (state.state !== "SOL_DIAGNOSIS") state = move(state, "SOL_DIAGNOSIS");
    const route = decideRoute("SOL_DIAGNOSIS", state.profile);
    const prompt = buildPrompt("SOL_DIAGNOSIS", "Diagnose the repeated failure and propose a revised plan. Do not edit files.", PLAN_SCHEMA, JSON.stringify(state.plan), evidenceText, state.profile.sensitivity);
    const request = { stage: "SOL_DIAGNOSIS" as const, route, ...prompt, sensitivity: state.profile.sensitivity, workingDirectory: projectDirectory } satisfies ProviderRequest;
    const workflow = (await this.attempts.status(state.taskId)).workflow;
    const response = await this.invokeTracked(state, this.modelAdapter, request, {
      approvalHash: executionApprovalHash(state.plan!, requiredIsolationHash(state)), round: state.repairAttempts,
      initial: workflow?.state ?? "REVIEW_PENDING", start: workflow?.state ?? "REVIEW_PENDING", success: "BLOCKED",
      validate: result => { const diagnosis = parseJson<DraftPlan>(result.text); validateDraftPlan(diagnosis); },
    });
    if (!response) return this.store.load(state.taskId);
    state = addResponse(state, route, response); state = move(state, "WAITING_REAPPROVAL");
    state = { ...state, approval: undefined, lastError: "Execution requires a revised plan and new approval" };
    await this.store.save(state, true); return state;
  }

  private async invokeTracked(
    state: RunState,
    adapter: ProviderAdapter,
    request: ProviderRequest,
    options: {
      approvalHash: string; round: number; initial: WorkflowState; start: WorkflowState; success: WorkflowState;
      validate?: (response: ProviderResponse) => void | Promise<void>;
      tracked?: DurableAttemptExecutor["execute"];
    },
  ): Promise<ProviderResponse | undefined> {
    const attemptRequest: AttemptExecutionRequest = {
      task_id: state.taskId, run_id: runIdFor(state.taskId), approval_hash: options.approvalHash,
      stage: request.stage, round: options.round, request_fingerprint: providerRequestFingerprint(request),
      initial_workflow_state: options.initial, start_workflow_state: options.start, success_workflow_state: options.success,
    };
    const execute = options.tracked ?? this.attempts.execute.bind(this.attempts);
    const result = await execute(attemptRequest, {
      prepare: async () => {
        if (request.routeBinding) preflightRouteBinding(request.routeBinding, request.route, adapterIdFor(request.route.provider));
        if (request.routeBinding && !adapter.preflight) throw new Error("Bound provider adapter does not implement route preflight");
        await adapter.preflight?.(request);
      },
      send: () => adapter.invoke(request),
      validate: async response => {
        if (typeof response.text !== "string" || response.text.length === 0) throw new Error("Provider response was incomplete");
        if (response.provider !== request.route.provider || response.model !== request.route.model) throw new Error("Provider response identity did not match the approved route");
        if (!response.requestId) throw new Error("Provider request ID was unavailable; complete route evidence is required");
        if (request.routeBinding) assertProviderRouteEvidence(request, response);
        await options.validate?.(response);
        return {
          complete: true, provider_request_id: response.requestId, response_model: response.model,
          response_origin: response.routeEvidence?.actualOrigin ?? "not_observable", usage: {
            input_tokens: response.usage.inputTokens, output_tokens: response.usage.outputTokens, reasoning_tokens: response.usage.reasoningTokens,
            cached_input_tokens: response.usage.cachedInputTokens, cache_write_tokens: response.usage.cacheWriteTokens, cache_hit_tokens: response.usage.cacheHitTokens, cache_miss_tokens: response.usage.cacheMissTokens,
          },
          transport_rounds: response.transportRounds ?? [], provider_reported_cost_usd: response.providerReportedCostUsd ?? null, estimated_list_cost_usd: response.estimatedListCostUsd ?? null,
        };
      },
    });
    return result.response;
  }
}

function move(state: RunState, next: LegacyWorkflowState): RunState { assertLegacyTransition(state.state, next); return transitionState(state, next); }
function parseJson<T>(text: string): T { const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]; const source = fenced ?? text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1); try { return JSON.parse(source) as T; } catch { throw new Error("Model output was not valid JSON"); } }
function requiredArray(value: string[] | undefined, name: string): string[] { if (!Array.isArray(value) || value.length === 0) throw new Error(`Plan field ${name} must be a non-empty array`); return value; }
function evidence(route: RouteDecision, response: ProviderResponse) {
  const availability = response.usageAvailability ?? { inputTokens: true, outputTokens: true, reasoningTokens: true, cacheHitTokens: true, cacheMissTokens: true };
  const cost = availability.inputTokens && availability.outputTokens ? estimateEquivalentUsd(route.model, response.usage) : undefined;
  const transport = response.routeEvidence ?? {
    routeBindingHash: null, adapterId: `${route.provider}-legacy`, expectedProvider: route.provider,
    expectedModel: route.model, expectedOrigin: null, expectedPath: null, actualOrigin: null, actualPath: null,
    actualModel: response.model, wireProtocol: null, authAlias: null, requestId: response.requestId,
    requestIds: response.requestId ? [response.requestId] : [], bodyResponseIds: [], headerRequestIds: [], requestIdSource: response.requestId ? "cli_event" as const : "not_available" as const,
    redirectPolicy: "not_observable" as const, redirected: null, routeTupleVerified: false, evidenceComplete: false,
    unverifiedReasons: ["transport_route_not_observable"], observations: [],
    verificationStatus: "incomplete" as const,
    peerVerification: "not_observable" as const, proxyVerification: "not_observable" as const,
  };
  return { ...transport, actualProvider: response.provider, verified: transport.verificationStatus === "local", usage: response.usage, ...(cost === undefined ? {} : { normalizedEquivalentUsd: cost, pricingCatalogVersion: PRICING_CATALOG_VERSION }) };
}
function addResponse(state: RunState, route: RouteDecision, response: ProviderResponse): RunState {
  const item = evidence(route, response); const observed = response.usageAvailability ?? { inputTokens: true, outputTokens: true, reasoningTokens: true, cacheHitTokens: true, cacheMissTokens: true };
  return { ...state, routeEvidence: [...(state.routeEvidence ?? []), item], usage: mergeUsage(state.usage, response.usage), usageAvailability: mergeUsageAvailability(state.usageAvailability, observed, state.usage === undefined), normalizedEquivalentUsd: item.normalizedEquivalentUsd === undefined ? state.normalizedEquivalentUsd : Math.round(((state.normalizedEquivalentUsd ?? 0) + item.normalizedEquivalentUsd) * 1e9) / 1e9 };
}
function mergeUsage(a: UsageMetrics | undefined, b: UsageMetrics): UsageMetrics { const base = a ?? { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0 }; return Object.fromEntries(Object.keys(base).map(key => [key, base[key as keyof UsageMetrics] + b[key as keyof UsageMetrics]])) as unknown as UsageMetrics; }
function mergeUsageAvailability(a: UsageAvailability | undefined, b: UsageAvailability, first: boolean): UsageAvailability { return first || !a ? { ...b } : { inputTokens: a.inputTokens && b.inputTokens, outputTokens: a.outputTokens && b.outputTokens, reasoningTokens: a.reasoningTokens && b.reasoningTokens, cacheHitTokens: a.cacheHitTokens && b.cacheHitTokens, cacheMissTokens: a.cacheMissTokens && b.cacheMissTokens }; }
function sumLegacyCosts(values: number[]): number { return Math.round(values.reduce((total, value) => total + value, 0) * 1e12) / 1e12; }
function sumLegacyRoundWall(rounds: Array<{ wall_clock_time_ms: number | null }>): number { return rounds.reduce((total, round) => total + (round.wall_clock_time_ms ?? 0), 0); }
function projectSummary(directory?: string): string { return JSON.stringify({ platform: process.platform, project: path.basename(directory ?? process.cwd()), sensitivePathsExcluded: true }); }
function runIdFor(taskId: string): string { return `run-${stableHash(taskId).slice(0, 24)}`; }
function preApprovalHash(taskId: string): string { return stableHash({ task_id: taskId, authority: "preapproval-planning" }); }
function executionApprovalHash(plan: PlanPacket, isolationHash: string): string { return stableHash({ task_id: plan.taskId, plan_hash: stableHash(plan), route: plan.route, isolation_hash: isolationHash }); }
function requiredIsolationHash(state: RunState): string { if (!state.approval?.isolationHash) throw new Error("Missing approved isolation binding"); return state.approval.isolationHash; }
function validateDraftPlan(value: DraftPlan): void {
  requiredArray(value.steps, "steps"); requiredArray(value.readFiles, "readFiles"); requiredArray(value.writeFiles, "writeFiles"); requiredArray(value.acceptance, "acceptance");
  if (!value || !["public", "private", "secret_restricted"].includes(value.dataClassification)) throw new Error("Plan field dataClassification is invalid");
}
function legacyEffectivePolicyHash(plan: PlanPacket, qualityPolicy: QualityGatePolicy): string { return stableHash({ provenance: "legacy_bridge", read_scope: plan.readFiles, write_scope: plan.writeFiles, data_classification: plan.dataClassification, route_binding_hash: plan.routeBinding.route_binding_hash, quality_policy_hash: qualityPolicy.policy_hash }); }
function qualitySecurityBlocked(report: QualityGateReport): boolean { const securityGates = new Set(["base_identity", "preapply_scope", "changed_files_scope", "forbidden_paths", "secret_scan", "diff_sanity", "final_freeze", "evidence_artifact", "gate_budget"]); return report.quality_gate_results.some(item => securityGates.has(item.gate_id) && item.outcome !== "passed") || report.tests_run.some(item => item.timed_out || item.output_overflowed || item.worktree_mutated); }
function validateReview(value: Review): void { if (!value || !["pass", "repair", "escalate"].includes(value.verdict)) throw new Error("Review response was incomplete"); }

const PLAN_SCHEMA = JSON.stringify({ type: "object", required: ["steps", "readFiles", "writeFiles", "dataClassification", "acceptance"], properties: { nonGoals: { type: "array", items: { type: "string" } }, steps: { type: "array", items: { type: "string" } }, readFiles: { type: "array", items: { type: "string" } }, writeFiles: { type: "array", items: { type: "string" } }, dataClassification: { enum: ["public", "private", "secret_restricted"] }, constraints: { type: "array", items: { type: "string" } }, acceptance: { type: "array", items: { type: "string" } } }, additionalProperties: false });
const REVIEW_SCHEMA = JSON.stringify({ type: "object", required: ["verdict"], properties: { verdict: { enum: ["pass", "repair", "escalate"] }, findings: { type: "array", items: { type: "string" } }, summary: { type: "string" }, finalText: { type: "string" } }, additionalProperties: false });
