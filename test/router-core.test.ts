import { access, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertEvidenceBundle } from "../src/contracts.js";
import { readEvidenceArtifact } from "../src/quality-gate.js";
import { DEFAULT_QUALITY_GATE_POLICY } from "../src/quality-gate.js";
import { LocalValidationAdapter } from "../src/providers/local.js";
import { RouterCoreService } from "../src/router-core.js";
import { GitWorktreeManager } from "../src/worktree.js";
import { canonicalFixture, directoryHash } from "./router-fixture.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))));

describe("S7 canonical Router core", () => {
  it("completes prepare, one approved execute, evidence review, and foreground finalize without touching main or Codex sentinels", async () => {
    const fixture = await canonicalFixture(); roots.push(fixture.root);
    const mainBefore = await readFile(path.join(fixture.project, "src", "parser.ts"), "utf8");
    const sentinelsBefore = await directoryHash(fixture.sentinels);
    const prepared = await fixture.core.prepare(fixture.task);
    expect(prepared).toMatchObject({ state: "AWAITING_APPROVAL", approved: false, next: "execute" });
    const executed = await fixture.core.execute(prepared.task_id, prepared.approval_summary.approval_summary_hash);
    expect(executed).toMatchObject({ state: "REVIEW_PENDING", approved: true, next: "review_evidence", evidence_bundle: { quality_passed: true } });
    expect(fixture.model.sends).toBe(1);
    const duplicate = await fixture.core.execute(prepared.task_id, prepared.approval_summary.approval_summary_hash);
    expect(duplicate.state).toBe("REVIEW_PENDING"); expect(fixture.model.sends).toBe(1);
    const review = await fixture.core.reviewEvidence(prepared.task_id);
    expect(review).toMatchObject({ quality_passed: true, files_changed: ["src/parser.ts"] });
    const finalized = await fixture.core.finalize(prepared.task_id, review.evidence_bundle_hash, "PASS", "Synthetic acceptance and evidence pass.");
    expect(finalized).toMatchObject({ state: "APPLY_PENDING", final_review: { decision: "PASS" }, next: "apply" });
    const repeated = await fixture.core.finalize(prepared.task_id, review.evidence_bundle_hash, "PASS", "Synthetic acceptance and evidence pass.");
    expect(repeated.final_review).toEqual(finalized.final_review);
    await expect(fixture.core.finalize(prepared.task_id, review.evidence_bundle_hash, "BLOCKED", "Replace the prior review.")).rejects.toThrow(/already recorded/);
    expect(await readFile(path.join(fixture.project, "src", "parser.ts"), "utf8")).toBe(mainBefore);
    expect(await directoryHash(fixture.sentinels)).toBe(sentinelsBefore);
    const bytes = await readEvidenceArtifact(fixture.state, review.evidence_bundle_reference);
    const bundle = JSON.parse(bytes.toString("utf8")) as unknown; assertEvidenceBundle(bundle);
    expect(bundle).toMatchObject({ contract_provenance: "canonical", task_package_hash: prepared.approval_summary.task_package_hash, route_binding_hash: prepared.approval_summary.route_binding_hash, policy_hash: prepared.approval_summary.policy_hash });
  });

  it("rejects a changed approval summary before worktree or provider side effects", async () => {
    const fixture = await canonicalFixture(); roots.push(fixture.root);
    const prepared = await fixture.core.prepare(fixture.task);
    await expect(fixture.core.execute(prepared.task_id, "0".repeat(64))).rejects.toThrow(/summary changed/);
    expect(fixture.model.sends).toBe(0);
    expect((await fixture.core.status(prepared.task_id)).state).toBe("AWAITING_APPROVAL");
  });

  it("aborts a prepared task without executing", async () => {
    const fixture = await canonicalFixture(); roots.push(fixture.root);
    const prepared = await fixture.core.prepare(fixture.task);
    expect((await fixture.core.abort(prepared.task_id)).state).toBe("ABORTED");
    expect(fixture.model.sends).toBe(0);
  });

  it("does not approve or prepare a terminal aborted task when execute is called later", async () => {
    const fixture = await canonicalFixture(); roots.push(fixture.root);
    const prepared = await fixture.core.prepare(fixture.task);
    await fixture.core.abort(prepared.task_id);
    const result = await fixture.core.execute(prepared.task_id, prepared.approval_summary.approval_summary_hash);
    expect(result).toMatchObject({ state: "ABORTED", approved: false, next: "none" });
    expect(fixture.model.sends).toBe(0);
  });

  it("fails closed before provider send when the S4 executor cannot prove an approved private capability", async () => {
    const fixture = await canonicalFixture(); roots.push(fixture.root);
    const prepared = await fixture.core.prepare({ ...fixture.task, task_id: "synthetic-private", data_classification: "private" });
    const result = await fixture.core.execute(prepared.task_id, prepared.approval_summary.approval_summary_hash);
    expect(result).toMatchObject({ state: "BLOCKED", next: "none" });
    expect(fixture.model.sends).toBe(0);
    expect(result.blocked_reason).toMatch(/public classification/i);
  });

  it("fails closed before provider send when actual read-scope bytes lack TaskPackage content-hash egress approval", async () => {
    const fixture = await canonicalFixture(); roots.push(fixture.root);
    const task = {
      ...fixture.task,
      context_manifest: [],
      egress_policy: { ...fixture.task.egress_policy, content_hashes: ["0".repeat(64)] },
    };
    const prepared = await fixture.core.prepare(task);
    const result = await fixture.core.execute(prepared.task_id, prepared.approval_summary.approval_summary_hash);
    expect(result.state).toBe("BLOCKED");
    expect(result.blocked_reason).toMatch(/content-hash egress approval/i);
    expect(fixture.model.sends).toBe(0);
  });

  it("rejects a state root inside the project before creating any persistence lock", async () => {
    const fixture = await canonicalFixture(); roots.push(fixture.root);
    const unsafeState = path.join(fixture.project, "router-state");
    const core = new RouterCoreService({ project_directory: fixture.project, state_root: unsafeState, user_policy: fixture.userPolicy, project_policy: fixture.projectPolicy, route_profile: fixture.routeProfile }, {
      model_adapter: fixture.model,
      local_adapter: new LocalValidationAdapter({ policy: DEFAULT_QUALITY_GATE_POLICY, evidenceRoot: fixture.state }),
      quality_policy: DEFAULT_QUALITY_GATE_POLICY,
      worktrees: new GitWorktreeManager({ stateRoot: unsafeState, managedRoot: fixture.worktrees }),
    });
    await expect(core.prepare(fixture.task)).rejects.toThrow(/isolation root|outside/i);
    await expect(access(path.join(unsafeState, "tasks"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(fixture.model.sends).toBe(0);
  });

  it("refuses finalization against any EvidenceBundle hash other than the current one", async () => {
    const fixture = await canonicalFixture(); roots.push(fixture.root);
    const prepared = await fixture.core.prepare(fixture.task);
    await fixture.core.execute(prepared.task_id, prepared.approval_summary.approval_summary_hash);
    await expect(fixture.core.finalize(prepared.task_id, "0".repeat(64), "PASS", "Synthetic review.")).rejects.toThrow(/not bound/);
    expect((await fixture.core.status(prepared.task_id)).state).toBe("REVIEW_PENDING");
  });
});
