import { readFile, readdir, rm, rmdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stableHash } from "../src/canonical.js";
import type { FinalReviewDecision, RouterCoreService, RouterReviewEvidence } from "../src/router-core.js";
import { canonicalFixture } from "./router-fixture.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(root => rmrf(root))));

class MockReviewer {
  constructor(private readonly decision: FinalReviewDecision | "UNAVAILABLE", private readonly summary: string) {}
  async review(core: RouterCoreService, evidence: RouterReviewEvidence) {
    if (this.decision === "UNAVAILABLE") throw new Error("synthetic GPT reviewer unavailable");
    return core.finalize(evidence.task_id, evidence.evidence_bundle_hash, this.decision, this.summary);
  }
}

async function executedFixture(options: Parameters<typeof canonicalFixture>[0] = {}) {
  const fixture = await canonicalFixture(options); roots.push(fixture.root);
  const prepared = await fixture.core.prepare(fixture.task);
  const executed = await fixture.core.execute(prepared.task_id, prepared.approval_summary.approval_summary_hash);
  const evidence = await fixture.core.reviewEvidence(prepared.task_id);
  return { ...fixture, prepared, executed, evidence };
}

describe("S8 foreground review, controlled repair, and explicit apply", () => {
  it("keeps REVIEW_PENDING and leaves main untouched when the mock GPT reviewer is unavailable", async () => {
    const fixture = await executedFixture();
    const mainBefore = await readFile(path.join(fixture.project, "src", "parser.ts"), "utf8");
    await expect(new MockReviewer("UNAVAILABLE", "not used").review(fixture.core, fixture.evidence)).rejects.toThrow(/reviewer unavailable/);
    await expect(fixture.core.finalize(fixture.prepared.task_id, fixture.evidence.evidence_bundle_hash, "UNKNOWN" as FinalReviewDecision, "Synthetic invalid verdict.")).rejects.toThrow(/must be PASS, REPAIR_REQUIRED, or BLOCKED/);
    expect(await fixture.core.status(fixture.prepared.task_id)).toMatchObject({ state: "REVIEW_PENDING", final_review: null, applied: false });
    expect(await readFile(path.join(fixture.project, "src", "parser.ts"), "utf8")).toBe(mainBefore);
  });

  it("creates one new REPAIR attempt, revalidates, then applies only after a second PASS review", async () => {
    const fixture = await executedFixture();
    const repairReview = await new MockReviewer("REPAIR_REQUIRED", "Change the synthetic parser result from 2 to 3.").review(fixture.core, fixture.evidence);
    expect(repairReview).toMatchObject({ state: "REPAIR_REQUIRED", repair_count: 0, next: "repair" });
    expect(await readFile(path.join(fixture.project, "src", "parser.ts"), "utf8")).toBe("export const parser = 1;\n");

    const repaired = await fixture.core.repair(fixture.prepared.task_id, fixture.evidence.evidence_bundle_hash, fixture.prepared.approval_summary.approval_summary_hash);
    expect(repaired).toMatchObject({ state: "REVIEW_PENDING", repair_count: 1, final_review: null, next: "review_evidence" });
    expect(fixture.model.sends).toBe(2);
    expect(fixture.model.budgetStates).toEqual([
      { attempts_used: 0, provider_requests_used: 0, input_tokens_used: 0, output_tokens_used: 0, wall_clock_time_ms_used: 0, estimated_list_cost_usd: 0 },
      { attempts_used: 1, provider_requests_used: 1, input_tokens_used: 12, output_tokens_used: 7, wall_clock_time_ms_used: 10, estimated_list_cost_usd: 0.00001452 },
    ]);
    expect(repaired.attempts.map(item => item.stage)).toEqual(["EXECUTE", "VALIDATE", "REPAIR", "VALIDATE"]);
    const repairAttempts = repaired.attempts.filter(item => item.stage === "REPAIR");
    expect(repairAttempts).toHaveLength(1);
    expect(repairAttempts[0].attempt_id).not.toBe(repaired.attempts.find(item => item.stage === "EXECUTE")?.attempt_id);

    const repairedEvidence = await fixture.core.reviewEvidence(fixture.prepared.task_id);
    expect(repairedEvidence.evidence_bundle_hash).not.toBe(fixture.evidence.evidence_bundle_hash);
    const pendingApply = await new MockReviewer("PASS", "The repaired synthetic evidence satisfies acceptance.").review(fixture.core, repairedEvidence);
    expect(pendingApply).toMatchObject({ state: "APPLY_PENDING", applied: false, next: "apply" });
    expect(await readFile(path.join(fixture.project, "src", "parser.ts"), "utf8")).toBe("export const parser = 1;\n");

    const applied = await fixture.core.apply(fixture.prepared.task_id, repairedEvidence.evidence_bundle_hash);
    expect(applied).toMatchObject({ state: "PASSED", applied: true, next: "none" });
    expect(await readFile(path.join(fixture.project, "src", "parser.ts"), "utf8")).toBe("export const parser = 3;\n");
    expect(await git(fixture.project, ["log", "--oneline"])).not.toContain("router");

    const duplicate = await fixture.core.apply(fixture.prepared.task_id, repairedEvidence.evidence_bundle_hash);
    expect(duplicate).toEqual(applied);
    expect(await readFile(path.join(fixture.project, "src", "parser.ts"), "utf8")).toBe("export const parser = 3;\n");
  });

  it("converges concurrent duplicate repair calls without a second provider side effect or terminal downgrade", async () => {
    const fixture = await executedFixture();
    await new MockReviewer("REPAIR_REQUIRED", "Change the synthetic parser result from 2 to 3.").review(fixture.core, fixture.evidence);
    const [first, second] = await Promise.all([
      fixture.core.repair(fixture.prepared.task_id, fixture.evidence.evidence_bundle_hash, fixture.prepared.approval_summary.approval_summary_hash),
      fixture.core.repair(fixture.prepared.task_id, fixture.evidence.evidence_bundle_hash, fixture.prepared.approval_summary.approval_summary_hash),
    ]);
    expect(fixture.model.sends).toBe(2);
    expect([first.state, second.state]).not.toContain("BLOCKED");
    expect((await fixture.core.status(fixture.prepared.task_id)).state).toBe("REVIEW_PENDING");
  });

  it("BLOCKS a failed repair attempt and never writes main", async () => {
    const fixture = await executedFixture({ repairBehavior: "invalid_scope" });
    await new MockReviewer("REPAIR_REQUIRED", "Make one bounded synthetic correction.").review(fixture.core, fixture.evidence);
    const result = await fixture.core.repair(fixture.prepared.task_id, fixture.evidence.evidence_bundle_hash, fixture.prepared.approval_summary.approval_summary_hash);
    expect(result).toMatchObject({ state: "BLOCKED", repair_count: 1, applied: false, next: "none" });
    expect(result.attempts.filter(item => item.stage === "REPAIR")).toHaveLength(1);
    expect(await readFile(path.join(fixture.project, "src", "parser.ts"), "utf8")).toBe("export const parser = 1;\n");
  });

  it("BLOCKS repair when a changed scope would require a different approval", async () => {
    const fixture = await executedFixture();
    await new MockReviewer("REPAIR_REQUIRED", "Make one bounded synthetic correction.").review(fixture.core, fixture.evidence);
    const changedScopeApproval = stableHash({ ...fixture.prepared.approval_summary, write_scope: ["src/parser.ts", "src/other.ts"] });
    const result = await fixture.core.repair(fixture.prepared.task_id, fixture.evidence.evidence_bundle_hash, changedScopeApproval);
    expect(result.state).toBe("BLOCKED");
    expect(result.blocked_reason).toMatch(/provider, model, budget, scope, privacy, or approval change/i);
    expect(fixture.model.sends).toBe(1);
  });

  it("BLOCKS apply when main workspace or the target preimage changes and preserves the user edit", async () => {
    const fixture = await executedFixture();
    const pending = await new MockReviewer("PASS", "Synthetic evidence passes.").review(fixture.core, fixture.evidence);
    expect(pending.state).toBe("APPLY_PENDING");
    await writeFile(path.join(fixture.project, "src", "parser.ts"), "export const parser = 99; // user dirty change\n");
    const result = await fixture.core.apply(fixture.prepared.task_id, fixture.evidence.evidence_bundle_hash);
    expect(result).toMatchObject({ state: "BLOCKED", applied: false, next: "none" });
    expect(result.blocked_reason).toMatch(/main workspace changed/i);
    expect(await readFile(path.join(fixture.project, "src", "parser.ts"), "utf8")).toBe("export const parser = 99; // user dirty change\n");
  });

  it("never overlays a target that was already dirty when the approved snapshot was captured", async () => {
    const fixture = await canonicalFixture(); roots.push(fixture.root);
    await writeFile(path.join(fixture.project, "src", "parser.ts"), "export const parser = 77; // pre-existing user draft\n");
    const prepared = await fixture.core.prepare(fixture.task);
    await fixture.core.execute(prepared.task_id, prepared.approval_summary.approval_summary_hash);
    const evidence = await fixture.core.reviewEvidence(prepared.task_id);
    await new MockReviewer("PASS", "The isolated synthetic diff passes review.").review(fixture.core, evidence);
    const result = await fixture.core.apply(prepared.task_id, evidence.evidence_bundle_hash);
    expect(result).toMatchObject({ state: "BLOCKED", applied: false });
    expect(await readFile(path.join(fixture.project, "src", "parser.ts"), "utf8")).toBe("export const parser = 77; // pre-existing user draft\n");
  });
});

// Windows fs.rm({ recursive: true }) can hang indefinitely on freshly created
// trees (git repos and copied dist are the worst offenders). A manual
// readdir+unlink+rmdir walk completes reliably, so cleanup uses it instead.
async function rmrf(dir: string): Promise<void> {
  let entries: import("node:fs").Dirent[];
  try { entries = await readdir(dir, { withFileTypes: true }); }
  catch { return; }
  for (const entry of entries) {
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) await rmrf(target);
    else await rm(target, { force: true }).catch(() => {});
  }
  await rmdir(dir).catch(() => {});
}

async function git(directory: string, args: string[]): Promise<string> {
  const child = spawn("git", args, { cwd: directory, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let stdout = ""; let stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk.toString(); }); child.stderr.on("data", chunk => { stderr += chunk.toString(); });
  const [code] = await once(child, "close") as [number];
  if (code !== 0) throw new Error(`synthetic git failed: ${stderr}`);
  return stdout;
}
