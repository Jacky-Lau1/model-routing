import { randomUUID } from "node:crypto";
import path from "node:path";
import { DurableAttemptExecutor, type AttemptExecutionRequest } from "./attempt-executor.js";
import { AttemptPersistence } from "./attempt-persistence.js";
import { approvePlan, assertApproval } from "./approval.js";
import { stableHash } from "./canonical.js";
import { classifyTask } from "./classifier.js";
import { buildPrompt } from "./context.js";
import { estimateEquivalentUsd, PRICING_CATALOG_VERSION } from "./cost.js";
import { StateStore, transitionState } from "./persistence.js";
import { decideRoute } from "./policy.js";
import { redactError } from "./redaction.js";
import { applyStructuredPatches, buildExecutorCapabilityGrant } from "./safe-executor.js";
import { assertLegacyTransition, canLegacyTransition } from "./state-machine.js";
import { assertAllowedChanges, snapshotWorkingTree } from "./scope-guard.js";
import { GitWorktreeManager, type WorktreeLease } from "./worktree.js";
import type { DataClassification, LegacyWorkflowState, PlanPacket, ProviderAdapter, ProviderRequest, ProviderResponse, RouteDecision, RunState, TaskProfile, UsageMetrics, WorkflowState } from "./types.js";

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
  ) {
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
    const plan: PlanPacket = {
      version: 1, taskId, objective, nonGoals: draft.nonGoals ?? [], steps: requiredArray(draft.steps, "steps"),
      readFiles: requiredArray(draft.readFiles, "readFiles"), writeFiles: requiredArray(draft.writeFiles, "writeFiles"),
      dataClassification: draft.dataClassification, allowedFiles: requiredArray(draft.writeFiles, "writeFiles"), constraints: draft.constraints ?? [],
      acceptance: requiredArray(draft.acceptance, "acceptance"), validationCommands: draft.validationCommands ?? [],
      route: decideRoute(executionStage, profile),
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
      if (!execution) return this.store.load(taskId);
      const scopeAfter = await snapshotWorkingTree(isolatedDirectory);
      assertAllowedChanges(scopeBefore, scopeAfter, plan.writeFiles);
      state = addResponse({ ...state, attempts: state.attempts + 1, result: execution.text }, plan.route, execution);
      state = move(state, "VALIDATING"); await this.store.save(state);
      let validation = await this.validate(state, isolatedDirectory);
      if (validation.response && validation.route) state = addResponse(state, validation.route, validation.response);
      if (!validation.passed) {
        state = await this.repairOrDiagnose(state, isolatedDirectory, validation.text);
        if (state.state === "WAITING_REAPPROVAL" || state.state === "BLOCKED") return state;
        validation = await this.validate(state, isolatedDirectory);
        if (validation.response && validation.route) state = addResponse(state, validation.route, validation.response);
        if (!validation.passed) return this.diagnose(state, isolatedDirectory, validation.text);
      }
      state = move(state, "REVIEWING"); await this.store.save(state);
      const reviewResult = await this.review(state, isolatedDirectory, validation.text);
      state = addResponse(state, reviewResult.route, reviewResult.response);
      if (reviewResult.review.verdict === "pass") { await this.worktrees.assertMainWorkspaceUnchanged(lease); await this.worktrees.retain(lease); state = { ...move(state, "COMPLETED"), result: reviewResult.review.finalText ?? reviewResult.review.summary ?? state.result }; await this.store.save(state, true); return state; }
      if (reviewResult.review.verdict === "repair" && state.repairAttempts === 0) {
        state = await this.repairOrDiagnose(state, isolatedDirectory, JSON.stringify(reviewResult.review));
        if (state.state === "WAITING_REAPPROVAL" || state.state === "BLOCKED") return state;
        const repairedValidation = await this.validate(state, isolatedDirectory);
        if (repairedValidation.response && repairedValidation.route) state = addResponse(state, repairedValidation.route, repairedValidation.response);
        if (!repairedValidation.passed) return this.diagnose(state, isolatedDirectory, repairedValidation.text);
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
    if (route.provider === "deepseek" && state.plan.dataClassification !== "public") throw new Error("Legacy DeepSeek execution requires an explicitly approved public classification");
    const codeExecution = route.stage === "EXECUTE" || route.stage === "REPAIR";
    const prompt = buildPrompt(route.stage, instruction, "Return a concise execution summary and evidence.", JSON.stringify({ readFiles: state.plan.readFiles, writeFiles: state.plan.writeFiles, constraints: state.plan.constraints }), JSON.stringify(state.plan), state.profile.sensitivity);
    const executorCapabilities = route.provider === "deepseek" && codeExecution
      ? await buildExecutorCapabilityGrant(projectDirectory, state.plan.readFiles, state.plan.writeFiles, state.plan.dataClassification)
      : undefined;
    const request = { stage: route.stage, route, ...prompt, sensitivity: state.profile.sensitivity, workingDirectory: projectDirectory, allowedFiles: state.plan.writeFiles, executorCapabilities } satisfies ProviderRequest;
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

  private async validate(state: RunState, projectDirectory: string): Promise<{ passed: boolean; text: string; route?: RouteDecision; response?: ProviderResponse }> {
    const commands = state.plan?.validationCommands ?? [];
    if (commands.length === 0) return { passed: true, text: JSON.stringify({ passed: true, skipped: "no validation commands" }) };
    const route = decideRoute("VALIDATE", state.profile);
    const request = { stage: "VALIDATE" as const, route, stablePrefix: "", projectSummary: "", dynamicInput: commands.join("\n"), sensitivity: state.profile.sensitivity, workingDirectory: projectDirectory } satisfies ProviderRequest;
    let parsed: { passed: boolean } | undefined;
    const response = await this.invokeTracked(state, this.localAdapter, request, {
      approvalHash: executionApprovalHash(state.plan!, requiredIsolationHash(state)), round: state.repairAttempts,
      initial: "VALIDATING", start: "VALIDATING", success: "REVIEW_PENDING",
      validate: result => { parsed = JSON.parse(result.text) as { passed: boolean }; if (typeof parsed.passed !== "boolean") throw new Error("Validation response was incomplete"); },
    });
    if (!response || !parsed) return { passed: false, text: JSON.stringify({ passed: false, blocked: "existing attempt" }) };
    return { passed: parsed.passed, text: response.text, route, response };
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
      send: () => adapter.invoke(request),
      validate: async response => {
        if (typeof response.text !== "string" || response.text.length === 0) throw new Error("Provider response was incomplete");
        if (response.provider !== request.route.provider || response.model !== request.route.model) throw new Error("Provider response identity did not match the approved route");
        await options.validate?.(response);
        return {
          complete: true, provider_request_id: response.requestId || "unreported", response_model: response.model,
          response_origin: `unverified://${response.provider}`, usage: {
            input_tokens: response.usage.inputTokens, output_tokens: response.usage.outputTokens, reasoning_tokens: response.usage.reasoningTokens,
          },
        };
      },
    });
    return result.response;
  }
}

function move(state: RunState, next: LegacyWorkflowState): RunState { assertLegacyTransition(state.state, next); return transitionState(state, next); }
function parseJson<T>(text: string): T { const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]; const source = fenced ?? text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1); try { return JSON.parse(source) as T; } catch { throw new Error("Model output was not valid JSON"); } }
function requiredArray(value: string[] | undefined, name: string): string[] { if (!Array.isArray(value) || value.length === 0) throw new Error(`Plan field ${name} must be a non-empty array`); return value; }
function evidence(route: RouteDecision, response: ProviderResponse) { const cost = estimateEquivalentUsd(route.model, response.usage); return { expectedProvider: route.provider, actualProvider: response.provider, expectedModel: route.model, actualModel: response.model, requestId: response.requestId, verified: response.provider === route.provider && response.model === route.model, usage: response.usage, normalizedEquivalentUsd: cost, pricingCatalogVersion: cost === undefined ? undefined : PRICING_CATALOG_VERSION }; }
function addResponse(state: RunState, route: RouteDecision, response: ProviderResponse): RunState { const item = evidence(route, response); return { ...state, routeEvidence: [...(state.routeEvidence ?? []), item], usage: mergeUsage(state.usage, response.usage), normalizedEquivalentUsd: item.normalizedEquivalentUsd === undefined ? state.normalizedEquivalentUsd : Math.round(((state.normalizedEquivalentUsd ?? 0) + item.normalizedEquivalentUsd) * 1e9) / 1e9 }; }
function mergeUsage(a: UsageMetrics | undefined, b: UsageMetrics): UsageMetrics { const base = a ?? { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0 }; return Object.fromEntries(Object.keys(base).map(key => [key, base[key as keyof UsageMetrics] + b[key as keyof UsageMetrics]])) as unknown as UsageMetrics; }
function projectSummary(directory?: string): string { return JSON.stringify({ platform: process.platform, project: path.basename(directory ?? process.cwd()), sensitivePathsExcluded: true }); }
function runIdFor(taskId: string): string { return `run-${stableHash(taskId).slice(0, 24)}`; }
function preApprovalHash(taskId: string): string { return stableHash({ task_id: taskId, authority: "preapproval-planning" }); }
function executionApprovalHash(plan: PlanPacket, isolationHash: string): string { return stableHash({ task_id: plan.taskId, plan_hash: stableHash(plan), route: plan.route, isolation_hash: isolationHash }); }
function requiredIsolationHash(state: RunState): string { if (!state.approval?.isolationHash) throw new Error("Missing approved isolation binding"); return state.approval.isolationHash; }
function providerRequestFingerprint(request: ProviderRequest): string { return stableHash({
  stage: request.stage, route: request.route, stable_prefix: request.stablePrefix, project_summary: request.projectSummary,
  dynamic_input: request.dynamicInput, sensitivity: request.sensitivity, allowed_files: request.allowedFiles ?? [],
  executor_capabilities: request.executorCapabilities ?? null, tools: request.tools ?? [],
}); }
function validateDraftPlan(value: DraftPlan): void {
  requiredArray(value.steps, "steps"); requiredArray(value.readFiles, "readFiles"); requiredArray(value.writeFiles, "writeFiles"); requiredArray(value.acceptance, "acceptance");
  if (!value || !["public", "private", "secret_restricted"].includes(value.dataClassification)) throw new Error("Plan field dataClassification is invalid");
}
function validateReview(value: Review): void { if (!value || !["pass", "repair", "escalate"].includes(value.verdict)) throw new Error("Review response was incomplete"); }

const PLAN_SCHEMA = JSON.stringify({ type: "object", required: ["steps", "readFiles", "writeFiles", "dataClassification", "acceptance"], properties: { nonGoals: { type: "array", items: { type: "string" } }, steps: { type: "array", items: { type: "string" } }, readFiles: { type: "array", items: { type: "string" } }, writeFiles: { type: "array", items: { type: "string" } }, dataClassification: { enum: ["public", "private", "secret_restricted"] }, constraints: { type: "array", items: { type: "string" } }, acceptance: { type: "array", items: { type: "string" } }, validationCommands: { type: "array", items: { type: "string" } } }, additionalProperties: false });
const REVIEW_SCHEMA = JSON.stringify({ type: "object", required: ["verdict"], properties: { verdict: { enum: ["pass", "repair", "escalate"] }, findings: { type: "array", items: { type: "string" } }, summary: { type: "string" }, finalText: { type: "string" } }, additionalProperties: false });
