import { randomUUID } from "node:crypto";
import path from "node:path";
import { approvePlan, assertApproval } from "./approval.js";
import { classifyTask } from "./classifier.js";
import { buildPrompt } from "./context.js";
import { estimateEquivalentUsd, PRICING_CATALOG_VERSION } from "./cost.js";
import { StateStore, transitionState } from "./persistence.js";
import { decideRoute } from "./policy.js";
import { assertTransition } from "./state-machine.js";
import { assertAllowedChanges, snapshotWorkingTree } from "./scope-guard.js";
import type { PlanPacket, ProviderAdapter, ProviderResponse, RouteDecision, RunState, TaskProfile, UsageMetrics, WorkflowState } from "./types.js";

export interface AutoOptions {
  projectDirectory?: string;
  profile?: Partial<TaskProfile>;
  taskId?: string;
}

interface DraftPlan { nonGoals?: string[]; steps: string[]; allowedFiles: string[]; constraints: string[]; acceptance: string[]; validationCommands?: string[] }
interface Review { verdict: "pass" | "repair" | "escalate"; findings?: string[]; summary?: string; finalText?: string }

export class RouterOrchestrator {
  constructor(
    private readonly modelAdapter: ProviderAdapter,
    private readonly localAdapter: ProviderAdapter,
    readonly store = new StateStore(),
  ) {}

  async auto(objective: string, options: AutoOptions = {}): Promise<RunState> {
    const taskId = options.taskId ?? `task-${randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    const profile = classifyTask(objective, options.profile);
    let state: RunState = { version: 1, taskId, state: "INTAKE", profile, attempts: 0, repairAttempts: 0, createdAt: now, updatedAt: now };
    state = move(state, "PROFILED"); state = move(state, "PLANNING");
    const planningStage = profile.kind === "text" ? "TEXT_FRAME" : "PLAN";
    const planningRoute = decideRoute(planningStage, profile);
    const prompt = buildPrompt(planningStage,
      "Create a decision-complete bounded plan. Do not execute or modify files. JSON only.",
      PLAN_SCHEMA, projectSummary(options.projectDirectory), objective, profile.sensitivity);
    const response = await this.modelAdapter.invoke({ stage: planningStage, route: planningRoute, ...prompt, sensitivity: profile.sensitivity, workingDirectory: options.projectDirectory });
    const draft = parseJson<DraftPlan>(response.text);
    const executionStage = profile.kind === "text" ? "TEXT_EXPAND" : "EXECUTE";
    const plan: PlanPacket = {
      version: 1, taskId, objective, nonGoals: draft.nonGoals ?? [], steps: requiredArray(draft.steps, "steps"),
      allowedFiles: requiredArray(draft.allowedFiles, "allowedFiles"), constraints: draft.constraints ?? [],
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
    let state = await this.store.load(taskId);
    if (!state.plan) throw new Error("Task has no plan");
    const plan = state.plan;
    state = { ...state, approval: approvePlan(plan) };
    assertApproval(plan, state.approval);
    state = move(state, "EXECUTING");
    const scopeBefore = await snapshotWorkingTree(projectDirectory);
    const execution = await this.invokeExecution(state, plan.route, projectDirectory, "Perform only the approved plan. Respect allowed files and stop conditions.");
    const scopeAfter = await snapshotWorkingTree(projectDirectory);
    try { assertAllowedChanges(scopeBefore, scopeAfter, plan.allowedFiles); }
    catch (error) { state = { ...move(state, "BLOCKED"), lastError: error instanceof Error ? error.message : String(error) }; await this.store.save(state, true); return state; }
    state = addResponse({ ...state, attempts: state.attempts + 1, result: execution.text }, plan.route, execution);
    state = move(state, "VALIDATING"); await this.store.save(state);
    let validation = await this.validate(state, projectDirectory);
    if (validation.response && validation.route) state = addResponse(state, validation.route, validation.response);
    if (!validation.passed) {
      state = await this.repairOrDiagnose(state, projectDirectory, validation.text);
      if (state.state === "WAITING_REAPPROVAL" || state.state === "BLOCKED") return state;
      validation = await this.validate(state, projectDirectory);
      if (validation.response && validation.route) state = addResponse(state, validation.route, validation.response);
      if (!validation.passed) return this.diagnose(state, projectDirectory, validation.text);
    }
    state = move(state, "REVIEWING"); await this.store.save(state);
    const reviewResult = await this.review(state, projectDirectory, validation.text);
    state = addResponse(state, reviewResult.route, reviewResult.response);
    if (reviewResult.review.verdict === "pass") { state = { ...move(state, "COMPLETED"), result: reviewResult.review.finalText ?? reviewResult.review.summary ?? state.result }; await this.store.save(state, true); return state; }
    if (reviewResult.review.verdict === "repair" && state.repairAttempts === 0) {
      state = await this.repairOrDiagnose(state, projectDirectory, JSON.stringify(reviewResult.review));
      if (state.state === "WAITING_REAPPROVAL" || state.state === "BLOCKED") return state;
      const repairedValidation = await this.validate(state, projectDirectory);
      if (repairedValidation.response && repairedValidation.route) state = addResponse(state, repairedValidation.route, repairedValidation.response);
      if (!repairedValidation.passed) return this.diagnose(state, projectDirectory, repairedValidation.text);
      state = move(state, "REVIEWING");
      const finalReview = await this.review(state, projectDirectory, repairedValidation.text);
      state = addResponse(state, finalReview.route, finalReview.response);
      if (finalReview.review.verdict === "pass") { state = { ...move(state, "COMPLETED"), result: finalReview.review.finalText ?? finalReview.review.summary ?? state.result }; await this.store.save(state, true); return state; }
    }
    return this.diagnose(state, projectDirectory, JSON.stringify(reviewResult.review));
  }

  async abort(taskId: string): Promise<RunState> {
    const state = move(await this.store.load(taskId), "ABORTED"); await this.store.save(state, true); return state;
  }

  private async invokeExecution(state: RunState, route: RouteDecision, projectDirectory: string, instruction: string): Promise<ProviderResponse> {
    if (!state.plan) throw new Error("Missing plan"); assertApproval(state.plan, state.approval);
    const prompt = buildPrompt(route.stage, instruction, "Return a concise execution summary and evidence.", JSON.stringify({ allowedFiles: state.plan.allowedFiles, constraints: state.plan.constraints }), JSON.stringify(state.plan), state.profile.sensitivity);
    return this.modelAdapter.invoke({ stage: route.stage, route, ...prompt, sensitivity: state.profile.sensitivity, workingDirectory: projectDirectory, allowedFiles: state.plan.allowedFiles });
  }

  private async validate(state: RunState, projectDirectory: string): Promise<{ passed: boolean; text: string; route?: RouteDecision; response?: ProviderResponse }> {
    const commands = state.plan?.validationCommands ?? [];
    if (commands.length === 0) return { passed: true, text: JSON.stringify({ passed: true, skipped: "no validation commands" }) };
    const route = decideRoute("VALIDATE", state.profile);
    const response = await this.localAdapter.invoke({ stage: "VALIDATE", route, stablePrefix: "", projectSummary: "", dynamicInput: commands.join("\n"), sensitivity: state.profile.sensitivity, workingDirectory: projectDirectory });
    const parsed = JSON.parse(response.text) as { passed: boolean };
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
    const response = await this.modelAdapter.invoke({ stage, route, ...prompt, sensitivity: state.profile.sensitivity, workingDirectory: projectDirectory });
    return { review: parseJson<Review>(response.text), route, response };
  }

  private async repairOrDiagnose(state: RunState, projectDirectory: string, evidenceText: string): Promise<RunState> {
    if (!state.plan || state.repairAttempts >= 1) return this.diagnose(state, projectDirectory, evidenceText);
    const plan = state.plan;
    state = move(state, "REPAIRING");
    const route = decideRoute("REPAIR", state.profile);
    const scopeBefore = await snapshotWorkingTree(projectDirectory);
    const repaired = await this.invokeExecution(state, route, projectDirectory, `Repair once using this evidence:\n${evidenceText}`);
    const scopeAfter = await snapshotWorkingTree(projectDirectory);
    try { assertAllowedChanges(scopeBefore, scopeAfter, plan.allowedFiles); }
    catch (error) { state = { ...move(state, "BLOCKED"), lastError: error instanceof Error ? error.message : String(error) }; await this.store.save(state, true); return state; }
    state = addResponse({ ...state, repairAttempts: 1, result: repaired.text }, route, repaired);
    state = move(state, "VALIDATING"); await this.store.save(state); return state;
  }

  private async diagnose(state: RunState, projectDirectory: string, evidenceText: string): Promise<RunState> {
    if (state.state !== "SOL_DIAGNOSIS") state = move(state, "SOL_DIAGNOSIS");
    const route = decideRoute("SOL_DIAGNOSIS", state.profile);
    const prompt = buildPrompt("SOL_DIAGNOSIS", "Diagnose the repeated failure and propose a revised plan. Do not edit files.", PLAN_SCHEMA, JSON.stringify(state.plan), evidenceText, state.profile.sensitivity);
    const response = await this.modelAdapter.invoke({ stage: "SOL_DIAGNOSIS", route, ...prompt, sensitivity: state.profile.sensitivity, workingDirectory: projectDirectory });
    state = addResponse(state, route, response); state = move(state, "WAITING_REAPPROVAL");
    state = { ...state, approval: undefined, lastError: "Execution requires a revised plan and new approval" };
    await this.store.save(state, true); return state;
  }
}

function move(state: RunState, next: WorkflowState): RunState { assertTransition(state.state, next); return transitionState(state, next); }
function parseJson<T>(text: string): T { const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]; const source = fenced ?? text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1); try { return JSON.parse(source) as T; } catch { throw new Error("Model output was not valid JSON"); } }
function requiredArray(value: string[] | undefined, name: string): string[] { if (!Array.isArray(value) || value.length === 0) throw new Error(`Plan field ${name} must be a non-empty array`); return value; }
function evidence(route: RouteDecision, response: ProviderResponse) { const cost = estimateEquivalentUsd(route.model, response.usage); return { expectedProvider: route.provider, actualProvider: response.provider, expectedModel: route.model, actualModel: response.model, requestId: response.requestId, verified: response.provider === route.provider && response.model === route.model, usage: response.usage, normalizedEquivalentUsd: cost, pricingCatalogVersion: cost === undefined ? undefined : PRICING_CATALOG_VERSION }; }
function addResponse(state: RunState, route: RouteDecision, response: ProviderResponse): RunState { const item = evidence(route, response); return { ...state, routeEvidence: [...(state.routeEvidence ?? []), item], usage: mergeUsage(state.usage, response.usage), normalizedEquivalentUsd: item.normalizedEquivalentUsd === undefined ? state.normalizedEquivalentUsd : Math.round(((state.normalizedEquivalentUsd ?? 0) + item.normalizedEquivalentUsd) * 1e9) / 1e9 }; }
function mergeUsage(a: UsageMetrics | undefined, b: UsageMetrics): UsageMetrics { const base = a ?? { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0 }; return Object.fromEntries(Object.keys(base).map(key => [key, base[key as keyof UsageMetrics] + b[key as keyof UsageMetrics]])) as unknown as UsageMetrics; }
function projectSummary(directory?: string): string { return JSON.stringify({ platform: process.platform, project: path.basename(directory ?? process.cwd()), sensitivePathsExcluded: true }); }

const PLAN_SCHEMA = JSON.stringify({ type: "object", required: ["steps", "allowedFiles", "acceptance"], properties: { nonGoals: { type: "array", items: { type: "string" } }, steps: { type: "array", items: { type: "string" } }, allowedFiles: { type: "array", items: { type: "string" } }, constraints: { type: "array", items: { type: "string" } }, acceptance: { type: "array", items: { type: "string" } }, validationCommands: { type: "array", items: { type: "string" } } }, additionalProperties: false });
const REVIEW_SCHEMA = JSON.stringify({ type: "object", required: ["verdict"], properties: { verdict: { enum: ["pass", "repair", "escalate"] }, findings: { type: "array", items: { type: "string" } }, summary: { type: "string" }, finalText: { type: "string" } }, additionalProperties: false });
